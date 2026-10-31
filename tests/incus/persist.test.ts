// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	coalescePersistedInstances,
	createIndexedDbAdapter,
	createMemoryAdapter,
	createPersistenceQueue,
	type PersistedInstance,
	persistableInstance,
	recordsFromAdapterResult,
} from "../../src/lib/incus/persist.ts";
import { createTabBridge, type TabMessage } from "../../src/lib/incus/tabs.ts";

function row(status: string, name = "web"): PersistedInstance {
	return {
		deploymentId: "east",
		project: "default",
		name,
		sessionGeneration: 1,
		fields: { name, status, project: "default" },
	};
}

describe("persistable instances", () => {
	it("strips config.user.secret and unknown expanded_config", () => {
		const fields = persistableInstance({
			name: "web",
			status: "Running",
			status_code: 103,
			config: { "user.secret": "do-not-keep" },
			expanded_config: { "user.secret": "do-not-keep" },
			devices: { eth0: { name: "eth0" } },
		});
		assert.equal(fields.name, "web");
		assert.equal(fields.status, "Running");
		assert.equal(fields.statusCode, 103);
		assert.equal("config" in fields, false);
		assert.equal("expanded_config" in fields, false);
		assert.equal("devices" in fields, false);
		assert.equal(JSON.stringify(fields).includes("do-not-keep"), false);
	});

	it("reads only safe rows from an adapter result", () => {
		const records = recordsFromAdapterResult([
			null,
			{ name: "missing" },
			{
				deploymentId: "east",
				project: "default",
				name: "web",
				sessionGeneration: 1,
				fields: {
					name: "web",
					status: "Running",
					config: { "user.secret": "do-not-keep" },
				},
			},
		]);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.fields.status, "Running");
		assert.equal("config" in (records[0]?.fields ?? {}), false);
	});

	it("coalesces rows without a store", () => {
		const records = coalescePersistedInstances([
			{ ...row("Running"), sessionGeneration: 5 },
			{ ...row("Stopped"), sessionGeneration: 2 },
			row("Frozen", "db"),
		]);
		assert.equal(records.length, 2);
		assert.equal(records[0]?.fields.status, "Running");
		assert.equal(records[1]?.name, "db");
	});
});

describe("persistence queue", () => {
	it("writes one record when the same instance is enqueued twice", async () => {
		const adapter = createMemoryAdapter();
		let writes = 0;
		const write = adapter.write.bind(adapter);
		adapter.write = (records) => {
			writes += 1;
			assert.equal(records.length, 1);
			return write(records);
		};
		const queue = createPersistenceQueue(adapter);
		const stopped = row("Stopped");
		(stopped.fields as Record<string, unknown>).config = {
			"user.secret": "do-not-keep",
		};
		queue.enqueue(row("Running"));
		queue.enqueue(stopped);
		await queue.flush();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(writes, 1);
		assert.equal(adapter.records.length, 1);
		assert.equal(adapter.records[0]?.fields.status, "Stopped");
		assert.equal("config" in (adapter.records[0]?.fields ?? {}), false);
		assert.equal(
			JSON.stringify(adapter.records).includes("do-not-keep"),
			false,
		);
	});

	it("keeps the queued record when a write fails", async () => {
		const adapter = createMemoryAdapter();
		adapter.failNextWrite = true;
		const errors: unknown[] = [];
		const queue = createPersistenceQueue(adapter, {
			onWriteError(error) {
				errors.push(error);
			},
		});
		queue.enqueue(row("Stopped"));
		await queue.flush();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(errors.length, 1);
		assert.equal(adapter.records.length, 0);
		await queue.flush();
		assert.equal(adapter.records.length, 1);
		assert.equal(adapter.records[0]?.fields.status, "Stopped");
	});

	it("drops pending writes and reports whether destroy deleted them", async () => {
		const adapter = createMemoryAdapter();
		const queue = createPersistenceQueue(adapter);
		queue.enqueue(row("Running"));
		assert.deepEqual(await queue.wipe(), { deleted: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await queue.flush();
		assert.equal(adapter.records.length, 0);

		queue.enqueue(row("Running"));
		await queue.flush();
		assert.equal(adapter.records.length, 1);

		adapter.failDestroy = true;
		queue.enqueue(row("Stopped"));
		assert.deepEqual(await queue.wipe(), { deleted: false });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(adapter.records.length, 1);
		assert.equal(adapter.records[0]?.fields.status, "Running");
		await queue.flush();
		assert.equal(adapter.records.length, 1);
		assert.equal(adapter.records[0]?.fields.status, "Running");
	});

	it("fails closed when IndexedDB is missing", async () => {
		const adapter = createIndexedDbAdapter("incus-ui-test");
		if (globalThis.indexedDB) return;
		await assert.rejects(() => adapter.read("east"));
		await assert.rejects(() => adapter.write([row("Running")]));
		assert.equal(await adapter.destroy(), false);
	});
});

describe("tab bridge", () => {
	it("ignores its own messages", () => {
		let logouts = 0;
		let delivered = 0;
		const posted: TabMessage[] = [];
		const bridge = createTabBridge({
			tabId: "tab-a",
			sessionGeneration: () => 1,
			onLogout: () => {
				logouts += 1;
			},
			onInstances: () => {
				delivered += 1;
			},
			post: (message) => {
				posted.push(message);
			},
		});
		try {
			bridge.publishLogout();
			const ownLogout = posted[0];
			assert.ok(ownLogout);
			bridge.handle(ownLogout);
			bridge.handle({
				kind: "instances",
				from: "tab-a",
				sessionGeneration: 1,
				deploymentId: "east",
				records: [row("Running")],
			});
			assert.equal(logouts, 0);
			assert.equal(delivered, 0);
			assert.equal(posted.length, 1);
		} finally {
			bridge.close();
		}
	});

	it("delivers the current session and ignores a stale one", () => {
		const delivered: PersistedInstance[][] = [];
		const bridge = createTabBridge({
			tabId: "tab-a",
			sessionGeneration: () => 4,
			onLogout: () => {
				throw new Error("logout should not run");
			},
			onInstances: (records) => {
				delivered.push(records);
			},
			post: () => {
				throw new Error("peer handling must not post");
			},
		});
		const dirty = {
			deploymentId: "east",
			project: "default",
			name: "web",
			sessionGeneration: 4,
			fields: {
				name: "web",
				status: "Running",
				expanded_config: { "user.secret": "do-not-keep" },
			},
		} as PersistedInstance;
		try {
			bridge.handle({
				kind: "instances",
				from: "tab-b",
				sessionGeneration: 4,
				deploymentId: "east",
				records: [dirty],
			});
			bridge.handle({
				kind: "instances",
				from: "tab-b",
				sessionGeneration: 3,
				deploymentId: "east",
				records: [row("Stopped")],
			});
			assert.equal(delivered.length, 1);
			assert.equal(delivered[0]?.[0]?.fields.status, "Running");
			assert.equal(
				"expanded_config" in (delivered[0]?.[0]?.fields ?? {}),
				false,
			);
			assert.equal(JSON.stringify(delivered).includes("do-not-keep"), false);
		} finally {
			bridge.close();
		}
	});

	it("logs a peer out without posting the message again", () => {
		let logouts = 0;
		const posted: TabMessage[] = [];
		const bridge = createTabBridge({
			tabId: "tab-a",
			sessionGeneration: () => 2,
			onLogout: () => {
				logouts += 1;
			},
			onInstances: () => {
				throw new Error("instances should not be delivered");
			},
			post: (message) => {
				posted.push(message);
			},
		});
		try {
			bridge.handle({
				kind: "logout",
				from: "tab-b",
				sessionGeneration: 2,
			});
			assert.equal(logouts, 1);
			assert.deepEqual(posted, []);
		} finally {
			bridge.close();
		}
	});
});
