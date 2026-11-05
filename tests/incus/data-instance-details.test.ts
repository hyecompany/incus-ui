// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseCapabilities } from "../../src/lib/incus/capabilities.ts";
import { DataCore } from "../../src/lib/incus/data/core.ts";
import { createInstancesApi, type InstancesApi } from "../../src/lib/incus/data/instances.ts";
import { createProjectsApi, type ProjectsApi } from "../../src/lib/incus/data/projects.ts";
import type { IncusEvent } from "../../src/lib/incus/events/types.ts";
import { ALL_PROJECTS, type ProjectScope } from "../../src/lib/incus/project-scope.ts";
import { FakeIncus, flush, mount } from "./fake-incus.ts";

const DEFAULT: ProjectScope = { kind: "project", name: "default" };
const lifecycle = (action: string, source: string, project = "default"): IncusEvent => ({
	type: "lifecycle",
	timestamp: "t",
	project,
	metadata: { action, source, context: {} },
});

let incus: FakeIncus;
let realFetch: typeof fetch;
let now: number;
let core: DataCore;
let api: InstancesApi;
let projects: ProjectsApi;
const stops: Array<() => void> = [];

function setup(extensions?: string[]) {
	core?.dispose();
	core = new DataCore({
		now: () => now,
		capabilities: extensions ? parseCapabilities({ api_extensions: extensions }) : undefined,
	});
	api = createInstancesApi(core, { runtimeSampleMs: 1_000 });
	projects = createProjectsApi(core);
	core.setCoverage("connected");
}

beforeEach(() => {
	incus = new FakeIncus();
	incus.add("default", "web");
	incus.add("default", "db", { status: "Stopped", profiles: ["default", "big"] });
	realFetch = globalThis.fetch;
	globalThis.fetch = incus.fetch as typeof fetch;
	now = 1_000;
	setup();
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	core.dispose();
	globalThis.fetch = realFetch;
});

describe("instance config and devices", () => {
	it("are separate groups of the object representation", async () => {
		const one = mount(api.watch({ project: "default", name: "web" }, ["config", "devices", "expandedConfig"]), stops);
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances/web?project=default"]);
		assert.deepEqual(one.get().data?.config, { "limits.cpu": "2" });
		assert.equal(one.get().data?.expandedConfig["profile.applied"], "yes");
		assert.equal(one.get().fresh, true);
	});

	it("an authoritative response removes config keys that are gone", async () => {
		const one = mount(api.watch({ project: "default", name: "web" }, ["config"]), stops);
		await flush();
		(incus.instances.get("default/web") as { config: Record<string, string> }).config = {};
		core.ingest(lifecycle("instance-updated", "/1.0/instances/web"));
		await flush();
		assert.deepEqual(one.get().data?.config, {});
	});

	it("a profile update invalidates the expanded config of instances using it, not others", async () => {
		const list = mount(api.watchList(["expandedConfig", "config"], DEFAULT), stops);
		await flush();
		incus.requests = [];
		core.ingest(lifecycle("profile-updated", "/1.0/profiles/big"));
		assert.equal(list.get().fresh, false);
		await flush();
		// Only db uses "big": one individual GET recomputes it.
		assert.deepEqual(incus.requests, ["/1.0/instances/db?project=default"]);
		assert.equal(list.get().fresh, true);
	});
});

describe("runtime state (sampled)", () => {
	it("one instance uses /state, and its status is learned too", async () => {
		const one = mount(api.watch({ project: "default", name: "web" }, ["memory", "processes"]), stops);
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances/web/state?project=default"]);
		assert.equal(one.get().data?.memory.usage, 100);
		const status = mount(api.watch({ project: "default", name: "web" }, ["status"]), stops);
		await flush();
		assert.equal(status.get().data?.status, "Running");
	});

	it("a whole collection's state uses one recursion=2 request", async () => {
		const list = mount(api.watchList(["memory"], DEFAULT), stops);
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances?recursion=2&project=default"]);
		assert.equal(list.get().available, true);
	});

	it("goes stale with age even with continuous event coverage, and is resampled", async () => {
		const one = mount(api.watch({ project: "default", name: "web" }, ["memory"]), stops);
		await flush();
		assert.equal(one.get().fresh, true);
		(incus.instances.get("default/web") as { memory: number }).memory = 200;
		now += 1_500;
		core.revalidate();
		await flush();
		assert.equal(incus.requests.length, 2);
		assert.equal(one.get().data?.memory.usage, 200);
	});

	it("a lifecycle event invalidates the sample", async () => {
		const one = mount(api.watch({ project: "default", name: "web" }, ["memory"]), stops);
		await flush();
		core.ingest(lifecycle("instance-stopped", "/1.0/instances/web"));
		assert.equal(one.get().fresh, false);
	});
});

describe("capabilities (#7)", () => {
	it("without api_filtering, a status query fetches the broader list and filters locally", async () => {
		setup(["instance_all_projects", "projects"]);
		const list = mount(api.watchList(["name"], DEFAULT, { status: "Running" }), stops);
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances?recursion=1&project=default"]);
		assert.deepEqual(list.get().data?.map((r) => r.name), ["web"]);
	});

	it("without all-projects support the result is an explicit unsupported error, not retried", async () => {
		setup(["api_filtering", "projects"]);
		const list = mount(api.watchList(["name"], ALL_PROJECTS), stops);
		await flush();
		assert.equal(list.get().error?.kind, "unsupported");
		assert.deepEqual(incus.requests, []);
		core.revalidate();
		await flush();
		assert.deepEqual(incus.requests, []);
	});

	it("without recursion=2 support, collection state falls back to /state requests", async () => {
		setup(["api_filtering", "instance_all_projects", "projects"]);
		const list = mount(api.watchList(["memory"], DEFAULT), stops);
		await flush();
		assert.ok(!incus.requests.some((r) => r.includes("recursion=2")));
		assert.ok(incus.requests.includes("/1.0/instances/db/state?project=default"));
		assert.equal(list.get().available, true);
	});
});

describe("relationships: project used_by", () => {
	it("establishes instance existence without another GET, and nothing else", async () => {
		const project = mount(projects.watch("default", ["usedBy"]), stops);
		await flush();
		assert.deepEqual(project.get().data?.usedBy, ["/1.0/instances/web", "/1.0/instances/db"]);
		incus.requests = [];
		const exists = mount(api.watch({ project: "default", name: "web" }, ["name"]), stops);
		await flush();
		assert.equal(exists.get().exists, true);
		assert.deepEqual(incus.requests, []);
		// Status was not established by used_by.
		const status = mount(api.watch({ project: "default", name: "web" }, ["status"]), stops);
		assert.equal(status.get().available, false);
	});

	it("an instance created in the project invalidates used_by but not description/config", async () => {
		const usedBy = mount(projects.watch("default", ["usedBy"]), stops);
		const details = mount(projects.watch("default", ["description"]), stops);
		await flush();
		core.ingest(lifecycle("instance-created", "/1.0/instances/new"));
		assert.equal(usedBy.get().fresh, false);
		assert.equal(details.get().fresh, true);
	});

	it("records the relationship; removal from used_by does not delete the instance", async () => {
		mount(projects.watch("default", ["usedBy"]), stops);
		await flush();
		const relation = core.store.relation("project\0default", "used-by");
		assert.equal(relation?.targets.has("instance\0default\0web"), true);
		incus.instances.delete("default/web");
		projects.refresh("default", ["usedBy"]);
		await flush();
		assert.equal(core.store.relation("project\0default", "used-by")?.targets.has("instance\0default\0web"), false);
		assert.equal(core.store.record("instance\0default\0web")?.exists, true);
	});
});
