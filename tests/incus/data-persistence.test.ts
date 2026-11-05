// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DataCore } from "../../src/lib/incus/data/core.ts";
import { createInstancesApi, type InstancesApi } from "../../src/lib/incus/data/instances.ts";
import {
	databaseName,
	MemoryBackend,
	openIndexedDb,
	Persistence,
} from "../../src/lib/incus/data/persistence.ts";
import { createProjectsApi } from "../../src/lib/incus/data/projects.ts";
import { type ChannelLike, TabSync } from "../../src/lib/incus/data/sync.ts";
import { readGeneration, registerDatabase, wipeIncusData } from "../../src/lib/incus/data/wipe.ts";
import type { IncusEvent } from "../../src/lib/incus/events/types.ts";
import type { ProjectScope } from "../../src/lib/incus/project-scope.ts";
import { FakeIncus, flush, mount } from "./fake-incus.ts";

const DEFAULT: ProjectScope = { kind: "project", name: "default" };
const WEB = { project: "default", name: "web" };

class FakeStorage {
	map = new Map<string, string>();
	getItem(key: string) {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.map.set(key, value);
	}
}

let incus: FakeIncus;
let realFetch: typeof fetch;
let now: number;
const stops: Array<() => void> = [];
const cores: DataCore[] = [];

function makeCore() {
	const core = new DataCore({ now: () => now });
	const api = createInstancesApi(core);
	createProjectsApi(core);
	core.setCoverage("connected");
	cores.push(core);
	return { core, api };
}

beforeEach(() => {
	incus = new FakeIncus();
	incus.add("default", "web", { config: { "limits.cpu": "2", "cloud-init.user-data": "password: hunter2" } });
	incus.add("default", "db", { config: { "limits.cpu": "1" } });
	realFetch = globalThis.fetch;
	globalThis.fetch = incus.fetch as typeof fetch;
	now = 1_000;
	(globalThis as unknown as { localStorage?: FakeStorage }).localStorage = new FakeStorage();
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const core of cores.splice(0)) core.dispose();
	globalThis.fetch = realFetch;
});

async function loadAll(api: InstancesApi) {
	mount(api.watchList(["status", "description", "config", "memory"], DEFAULT), stops);
	await flush();
}

describe("persistence", () => {
	it("writes asynchronously, coalesced, in bounded batches", async () => {
		const backend = new MemoryBackend();
		const { core, api } = makeCore();
		const persistence = new Persistence(core, backend, { flushMs: 60_000, batchSize: 2 });
		await persistence.start();
		await loadAll(api);
		assert.equal(backend.commits.length, 0, "nothing is written before the flush window");
		await persistence.flush();
		assert.ok(backend.commits.length >= 2);
		assert.ok(backend.commits.every((c) => c.records.length + c.collections.length <= 2));
		assert.ok(backend.records.has("instance\0default\0web"));
	});

	it("never persists secrets or unclassified groups (filtered before the queue)", async () => {
		const backend = new MemoryBackend();
		const { core, api } = makeCore();
		const persistence = new Persistence(core, backend, { flushMs: 0 });
		await persistence.start();
		await loadAll(api);
		await persistence.flush();
		const text = JSON.stringify(backend.commits);
		assert.ok(!text.includes("hunter2"));
		const groups = (key: string) => backend.records.get(key)?.groups.map((g) => g.name).sort();
		// web's config holds cloud-init data: kept in memory only.
		assert.deepEqual(groups("instance\0default\0web"), ["ordinary", "status"]);
		// db's config is allowlisted, so it persists whole. Its expanded config has an
		// unclassified key ("profile.applied"), so that group stays in memory. Runtime never persists.
		assert.deepEqual(groups("instance\0default\0db"), ["config", "ordinary", "status"]);
	});

	it("hydrates usable but never-fresh data, and validates it", async () => {
		const backend = new MemoryBackend();
		{
			const { core, api } = makeCore();
			const p = new Persistence(core, backend, { flushMs: 0 });
			await p.start();
			await loadAll(api);
			await p.flush();
			p.stop();
		}
		incus.requests = [];
		globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch; // server is slow
		const { core, api } = makeCore();
		await new Persistence(core, backend).start();
		const list = mount(api.watchList(["description"], DEFAULT), stops);
		await flush();
		assert.equal(list.get().available, true);
		assert.equal(list.get().fresh, false);
		assert.equal(list.get().fetching, true, "restored data is revalidated");
	});

	it("an older stored value never overwrites a newer in-memory observation", async () => {
		const backend = new MemoryBackend();
		{
			const { core, api } = makeCore();
			const p = new Persistence(core, backend, { flushMs: 0 });
			await p.start();
			await loadAll(api);
			await p.flush();
		}
		(incus.instances.get("default/web") as { description: string }).description = "newer";
		now = 5_000;
		const { core, api } = makeCore();
		const one = mount(api.watch(WEB, ["description"]), stops);
		await flush();
		await new Persistence(core, backend).start();
		assert.equal(one.get().data?.description, "newer");
		assert.equal(one.get().fresh, true);
	});

	it("an interrupted write cannot restore a 'complete' collection missing members", async () => {
		const backend = new MemoryBackend();
		backend.collections.set("instances\0project:default\0", {
			key: "instances\0project:default\0",
			members: ["instance\0default\0web", "instance\0default\0db"],
			complete: true,
			validation: { at: 1, epoch: null },
			invalid: false,
		});
		backend.records.set("instance\0default\0web", {
			key: "instance\0default\0web",
			lifecycle: 0,
			exists: true,
			existence: { at: 1, epoch: null },
			groups: [],
		});
		const { core } = makeCore();
		await new Persistence(core, backend).start();
		assert.equal(core.store.collection("instances\0project:default\0")?.complete, false);
	});

	it("a storage failure keeps serving from memory", async () => {
		const backend = new MemoryBackend();
		backend.fail = true;
		const errors: unknown[] = [];
		const { core, api } = makeCore();
		const p = new Persistence(core, backend, { flushMs: 0, onError: (e) => errors.push(e) });
		await p.start();
		const list = mount(api.watchList(["description"], DEFAULT), stops);
		await flush();
		await p.flush();
		assert.equal(errors.length, 1);
		assert.equal(list.get().available, true);
		assert.equal(list.get().fresh, true);
	});

	it("stops writing once another tab logged out (generation changed)", async () => {
		const backend = new MemoryBackend();
		const { core, api } = makeCore();
		const generation = readGeneration();
		const p = new Persistence(core, backend, { flushMs: 60_000, isCurrent: () => readGeneration() === generation });
		await p.start();
		await loadAll(api);
		await wipeIncusData({ indexedDB: undefined, broadcast: () => undefined });
		await p.flush();
		assert.equal(backend.commits.length, 0);
	});
});

describe("IndexedDB backend", () => {
	it("round-trips records and collections atomically", async () => {
		const db = await openIndexedDb(databaseName("dep/tls:u"));
		await db.commit({
			records: [{ key: "instance\0p\0a", value: { key: "instance\0p\0a", lifecycle: 0, exists: true, groups: [] } }],
			collections: [{ key: "instances\0all\0", value: { key: "instances\0all\0", members: ["instance\0p\0a"], complete: true, invalid: false } }],
		});
		const loaded = await db.load({ records: ["instance\0"], collections: ["instances\0"] });
		assert.equal(loaded.records.length, 1);
		assert.equal(loaded.collections[0]?.complete, true);
		db.close();
	});

	it("logout deletes every Incus UI database, even with a connection open elsewhere", async () => {
		const names = [databaseName("a/tls:x"), databaseName("b/oidc:y")];
		const open = [];
		for (const name of names) {
			registerDatabase(name);
			open.push(await openIndexedDb(name));
		}
		const result = await wipeIncusData({ broadcast: () => undefined, blockedTimeoutMs: 200 });
		assert.equal(result.complete, true, JSON.stringify(result));
		const left = (await indexedDB.databases()).map((d) => d.name);
		for (const name of names) assert.ok(!left.includes(name));
	});

	it("reports blocked deletion instead of claiming success", async () => {
		const name = databaseName("c/tls:z");
		registerDatabase(name);
		const request = indexedDB.open(name, 1);
		const db = await new Promise<IDBDatabase>((resolve) => {
			request.onsuccess = () => resolve(request.result);
		});
		db.onversionchange = null; // a connection that does not cooperate
		const result = await wipeIncusData({ broadcast: () => undefined, blockedTimeoutMs: 50 });
		assert.equal(result.complete, false);
		assert.deepEqual(result.blocked, [name]);
		db.close();
		await flush();
	});
});

/** Two in-process "tabs" connected by a fake BroadcastChannel. */
function channelPair(): [ChannelLike, ChannelLike, { sent: number }] {
	const stats = { sent: 0 };
	const make = (): ChannelLike & { peer?: ChannelLike } => ({
		onmessage: null,
		postMessage(message) {
			stats.sent += 1;
			const peer = this.peer;
			const data = structuredClone(message);
			queueMicrotask(() => peer?.onmessage?.({ data }));
		},
		close() {},
	});
	const a = make();
	const b = make();
	a.peer = b;
	b.peer = a;
	return [a, b, stats];
}

describe("tabs", () => {
	it("share observations so the other tab does not refetch", async () => {
		const [ca, cb] = channelPair();
		const a = makeCore();
		const b = makeCore();
		new TabSync(a.core, ca, { tabId: "a" }).start();
		new TabSync(b.core, cb, { tabId: "b" }).start();
		mount(a.api.watchList(["description"], DEFAULT), stops);
		await flush();
		incus.requests = [];
		const list = mount(b.api.watchList(["description"], DEFAULT), stops);
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.equal(list.get().available, true);
		assert.equal(list.get().fresh, true);
	});

	it("propagate invalidations and deletions, without rebroadcast loops", async () => {
		const [ca, cb, stats] = channelPair();
		const a = makeCore();
		const b = makeCore();
		new TabSync(a.core, ca, { tabId: "a" }).start();
		new TabSync(b.core, cb, { tabId: "b" }).start();
		mount(a.api.watchList(["description"], DEFAULT), stops);
		await flush();
		const before = stats.sent;
		now = 2_000;
		const event: IncusEvent = {
			type: "lifecycle",
			timestamp: "t",
			metadata: { action: "instance-deleted", source: "/1.0/instances/db", context: {} },
		};
		a.core.ingest(event);
		await flush();
		assert.equal(b.core.store.record("instance\0default\0db")?.exists, false);
		// a -> b only; b does not echo it back.
		assert.ok(stats.sent - before <= 2, `sent ${stats.sent - before}`);
	});

	it("same-time opposite observations are ambiguous and get revalidated", async () => {
		const { core } = makeCore();
		const key = "instance\0default\0web";
		core.mutate((ctx) => ctx.store.markExists(key, { at: 1_000, epoch: core.coverage.epoch }));
		core.mutate((ctx) =>
			ctx.store.mergeRecord(
				{ key, lifecycle: 0, exists: false, existence: { at: 1_000, epoch: null }, groups: [] },
				(v) => v,
			),
		);
		assert.equal(core.context.isFresh(core.store.record(key)?.existence), false);
	});

	it("an older observation from another tab does not win because it arrived later", async () => {
		const [ca, cb] = channelPair();
		const a = makeCore();
		const b = makeCore();
		new TabSync(b.core, cb, { tabId: "b" }).start();
		mount(a.api.watch(WEB, ["description"]), stops); // a fetches at t=1000
		await flush();
		(incus.instances.get("default/web") as { description: string }).description = "newer";
		now = 2_000;
		const one = mount(b.api.watch(WEB, ["description"]), stops); // b fetches at t=2000
		await flush();
		new TabSync(a.core, ca, { tabId: "a" }).start();
		// a re-announces its (older, t=1000) snapshot after b's newer read.
		a.core.mutate((ctx) => ctx.store.markExists("instance\0default\0web", { at: 1_000, epoch: 1 }));
		await flush();
		assert.equal(one.get().data?.description, "newer");
	});

	it("ignore messages from a wiped (older) generation", async () => {
		const [ca, cb] = channelPair();
		const a = makeCore();
		const b = makeCore();
		new TabSync(a.core, ca, { tabId: "a", generation: () => 1 }).start();
		new TabSync(b.core, cb, { tabId: "b", generation: () => 2 }).start();
		mount(a.api.watchList(["description"], DEFAULT), stops);
		await flush();
		assert.equal(b.core.store.record("instance\0default\0web"), undefined);
	});
});
