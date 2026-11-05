// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { replaceEqualDeep } from "../../src/lib/incus/data/consumers.ts";
import { DataCore } from "../../src/lib/incus/data/core.ts";
import { createInstancesApi, type InstancesApi } from "../../src/lib/incus/data/instances.ts";
import { createProjectsApi, type ProjectsApi } from "../../src/lib/incus/data/projects.ts";
import type { IncusEvent } from "../../src/lib/incus/events/types.ts";
import type { ProjectScope } from "../../src/lib/incus/project-scope.ts";
import { FakeIncus, flush } from "./fake-incus.ts";

const DEFAULT: ProjectScope = { kind: "project", name: "default" };
const WEB: ProjectScope = { kind: "project", name: "web" };
const lifecycle = (action: string, source: string, project = "default"): IncusEvent => ({
	type: "lifecycle",
	timestamp: "t",
	project,
	metadata: { action, source, context: {} },
});

let incus: FakeIncus;
let realFetch: typeof fetch;
let core: DataCore;
let api: InstancesApi;
let projects: ProjectsApi;
const stops: Array<() => void> = [];

beforeEach(() => {
	incus = new FakeIncus();
	incus.add("default", "a");
	incus.add("default", "b");
	incus.add("web", "nginx");
	realFetch = globalThis.fetch;
	globalThis.fetch = incus.fetch as typeof fetch;
	core = new DataCore({ now: () => 1_000 });
	api = createInstancesApi(core);
	projects = createProjectsApi(core);
	core.setCoverage("connected");
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	core.dispose();
	globalThis.fetch = realFetch;
});

/** Mounts a watch and counts how often it notifies. */
function counted<R>(watch: { subscribe(cb: () => void): () => void; getSnapshot(): R }) {
	const counter = { notified: 0, get: () => watch.getSnapshot() };
	stops.push(watch.subscribe(() => (counter.notified += 1)));
	return counter;
}

describe("replaceEqualDeep", () => {
	it("returns the previous value when deeply equal", () => {
		const prev = { data: [{ name: "a", x: 1 }], fresh: true };
		assert.equal(replaceEqualDeep(prev, { data: [{ name: "a", x: 1 }], fresh: true }), prev);
	});

	it("keeps unchanged rows and replaces changed ones", () => {
		const prev = { data: [{ name: "a" }, { name: "b", x: 1 }] };
		const next = replaceEqualDeep(prev, { data: [{ name: "a" }, { name: "b", x: 2 }] });
		assert.notEqual(next, prev);
		assert.equal(next.data[0], prev.data[0]);
		assert.notEqual(next.data[1], prev.data[1]);
		assert.deepEqual(next.data[1], { name: "b", x: 2 });
	});

	it("detects added, removed and undefined-valued keys", () => {
		const prev: Record<string, unknown> = { a: 1 };
		assert.notEqual(replaceEqualDeep(prev, { a: 1, b: undefined }), prev);
		assert.notEqual(replaceEqualDeep({ a: 1, b: 2 }, { a: 1 }), prev);
		assert.notEqual(replaceEqualDeep([1, 2], [1]), prev);
	});

	it("compares non-plain objects by reference", () => {
		const error = new Error("x");
		const prev = { error };
		assert.equal(replaceEqualDeep(prev, { error }), prev);
		assert.notEqual(replaceEqualDeep(prev, { error: new Error("x") }), prev);
	});
});

describe("consumer updates", () => {
	it("an event about another project's instance does not recompute a scoped list", async () => {
		const list = counted(api.watchList(["status"], DEFAULT));
		const other = counted(api.watchList(["status"], WEB));
		await flush();
		const before = list.get();
		const notified = list.notified;
		(incus.instances.get("web/nginx") as { status: string }).status = "Stopped";
		core.ingest(lifecycle("instance-stopped", "/1.0/instances/nginx?project=web", "web"));
		await flush();
		assert.equal(list.notified, notified);
		assert.equal(list.get(), before);
		assert.equal(other.get().data?.[0]?.status, "Stopped");
	});

	it("unchanged rows keep their identity when one row changes", async () => {
		const list = counted(api.watchList(["status"], DEFAULT));
		await flush();
		const [a, b] = list.get().data ?? [];
		core.ingest(lifecycle("instance-stopped", "/1.0/instances/b"));
		await flush();
		const rows = list.get().data ?? [];
		assert.equal(rows.find((r) => r.name === "a"), a);
		assert.notEqual(rows.find((r) => r.name === "b"), b);
		assert.equal(rows.find((r) => r.name === "b")?.status, "Stopped");
	});

	it("still reacts to request state (fetching) with no store change", async () => {
		const list = counted(api.watchList(["status"], DEFAULT));
		assert.equal(list.get().fetching, false);
		await Promise.resolve();
		await Promise.resolve();
		// The request started: no store key changed, but the result did.
		assert.equal(list.get().fetching, true);
		assert.equal(list.get().data, undefined);
		await flush();
		assert.equal(list.get().fetching, false);
		assert.equal(list.get().available, true);
	});
});

describe("prefetch", () => {
	it("loads a list before its consumer mounts, which then needs no request", async () => {
		api.prefetchList(["status"], WEB);
		await flush();
		const requests = incus.requests.length;
		assert.ok(requests > 0);
		const list = counted(api.watchList(["status"], WEB));
		await flush();
		assert.equal(incus.requests.length, requests);
		assert.equal(list.get().available, true);
		assert.deepEqual(
			list.get().data?.map((r) => r.name),
			["nginx"],
		);
	});

	it("shares the request with a consumer that mounts while it is in flight", async () => {
		api.prefetchList(["status"], WEB);
		const list = counted(api.watchList(["status"], WEB));
		await flush();
		assert.equal(incus.requests.filter((r) => r.startsWith("/1.0/instances?")).length, 1);
		assert.equal(list.get().available, true);
	});

	it("ends the hold when cancelled", async () => {
		const cancel = projects.prefetchList(["name"]);
		cancel();
		cancel();
		await flush();
		// Released before the scheduler ran: nothing to plan.
		assert.equal(incus.requests.length, 0);
	});
});
