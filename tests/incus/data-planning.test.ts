// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/* Request planning regressions: coverage across definitions, planned needs, forced refreshes, replay epochs, uncovered expiry. */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DataCore } from "../../src/lib/incus/data/core.ts";
import { createInstancesApi, type InstancesApi } from "../../src/lib/incus/data/instances.ts";
import { createProjectsApi, type ProjectsApi } from "../../src/lib/incus/data/projects.ts";
import type { IncusEvent } from "../../src/lib/incus/events/types.ts";
import type { ProjectScope } from "../../src/lib/incus/project-scope.ts";
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

function setup(options: { uncoveredTtlMs?: number; connected?: boolean } = {}) {
	core?.dispose();
	core = new DataCore({ now: () => now, uncoveredTtlMs: options.uncoveredTtlMs });
	api = createInstancesApi(core);
	projects = createProjectsApi(core);
	if (options.connected !== false) core.setCoverage("connected");
}

/** Requests whose URL matches wait for the returned `open()`, or fail with `status`. */
function intercept(match: (url: string) => boolean, status?: number) {
	let open = () => undefined as void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const inner = globalThis.fetch;
	const seen: string[] = [];
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = decodeURIComponent(String(input));
		if (!match(url)) return inner(input as string, init);
		seen.push(url);
		if (status !== undefined)
			return new Response(JSON.stringify({ type: "error", error_code: status, error: "denied" }), { status });
		await gate;
		return inner(input as string, init);
	}) as typeof fetch;
	return { open, seen };
}

const ticks = async () => {
	for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeEach(() => {
	incus = new FakeIncus();
	incus.add("default", "a");
	incus.add("default", "b", { status: "Stopped" });
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

describe("coverage is scoped to the request's definition", () => {
	it("an instance GET planned while a project list is watched is sent and settles", async () => {
		mount(projects.watchList(["name"]), stops);
		const list = mount(api.watchList(["description"], DEFAULT), stops);
		await flush();
		const before = incus.requests.length;
		core.ingest(lifecycle("instance-updated", "/1.0/instances/a"));
		await flush();
		assert.deepEqual(incus.requests.slice(before), ["/1.0/instances/a?project=default"]);
		assert.equal(list.get().fetching, false);
		assert.equal(list.get().available, true);
	});
});

describe("individual GETs keep the needs they were planned for", () => {
	it("resolving an undecided member of a status list reports fetching", async () => {
		const list = mount(api.watchList(["status"], DEFAULT, { status: "Running" }), stops);
		await flush();
		incus.add("default", "new");
		const gate = intercept((url) => url.startsWith("/1.0/instances/new"));
		core.ingest(lifecycle("instance-created", "/1.0/instances/new"));
		await ticks();
		assert.equal(gate.seen.length, 1);
		assert.equal(list.get().fetching, true);
		gate.open();
		await flush();
		assert.equal(list.get().fetching, false);
		assert.deepEqual(
			list.get().data?.map((r) => r.name),
			["a", "new"],
		);
	});

	it("a failed resolution is recorded on the list and not retried at once", async () => {
		const list = mount(api.watchList(["status"], DEFAULT, { status: "Running" }), stops);
		await flush();
		incus.add("default", "new");
		const denied = intercept((url) => url.startsWith("/1.0/instances/new"), 403);
		core.ingest(lifecycle("instance-created", "/1.0/instances/new"));
		await flush();
		await flush();
		assert.equal(list.get().error?.kind, "forbidden");
		assert.equal(denied.seen.length, 1);
	});

	it("a failed project-updated refresh is recorded on the details list", async () => {
		const list = mount(projects.watchList(["description"]), stops);
		await flush();
		const denied = intercept((url) => url.startsWith("/1.0/projects/default"), 403);
		core.ingest(lifecycle("project-updated", "/1.0/projects/default"));
		await flush();
		await flush();
		assert.equal(denied.seen.length, 1);
		assert.equal(list.get().error?.kind, "forbidden");
	});
});

describe("explicit refresh", () => {
	it("refreshList revalidates a fresh instance list", async () => {
		mount(api.watchList(["status"], DEFAULT), stops);
		await flush();
		const before = incus.requests.length;
		api.refreshList(["status"], DEFAULT);
		await flush();
		assert.equal(incus.requests.length, before + 1);
		assert.match(incus.requests.at(-1) ?? "", /^\/1\.0\/instances\?/);
	});

	it("refreshList revalidates a fresh project details list", async () => {
		mount(projects.watchList(["description"]), stops);
		await flush();
		const before = incus.requests.length;
		projects.refreshList(["description"]);
		await flush();
		assert.equal(incus.requests.length, before + 1);
	});

	it("refresh revalidates one fresh instance", async () => {
		mount(api.watch({ project: "default", name: "a" }, ["description"]), stops);
		await flush();
		const before = incus.requests.length;
		api.refresh({ project: "default", name: "a" }, ["description"]);
		await flush();
		assert.deepEqual(incus.requests.slice(before), ["/1.0/instances/a?project=default"]);
	});
});

describe("journal replay", () => {
	it("events from before a reconnect do not become fresh in the new epoch", async () => {
		const gate = intercept((url) => url.startsWith("/1.0/instances/b?"));
		const one = mount(api.watch({ project: "default", name: "b" }, ["status"]), stops);
		await ticks();
		assert.equal(gate.seen.length, 1);
		// Seen during the request, then the connection drops and comes back.
		core.ingest(lifecycle("instance-started", "/1.0/instances/b"));
		core.setCoverage("interrupted");
		core.setCoverage("connected");
		globalThis.fetch = incus.fetch as typeof fetch;
		gate.open();
		await flush();
		// The pre-gap facts were revalidated by a GET in the new epoch.
		assert.equal(
			incus.requests.filter((r) => r.startsWith("/1.0/instances/b?")).length,
			2,
		);
		assert.equal(one.get().fresh, true);
		assert.equal(one.get().data?.status, "Stopped");
	});
});

describe("without event coverage", () => {
	it("expired facts are reported stale and revalidated without other activity", async () => {
		setup({ uncoveredTtlMs: 200, connected: false });
		const list = mount(api.watchList(["status"], DEFAULT), stops);
		await flush();
		assert.equal(list.get().fresh, true);
		const before = incus.requests.length;
		now += 1_000;
		await new Promise((resolve) => setTimeout(resolve, 300));
		await flush();
		assert.equal(incus.requests.length, before + 1);
		assert.equal(list.get().fresh, true);
	});
});
