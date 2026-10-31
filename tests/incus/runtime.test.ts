// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureInstances, readInstances } from "../../src/lib/incus/runtime.ts";
import { createIncusStore } from "../../src/lib/incus/store.ts";

function envelope(metadata: unknown, status = 200): Response {
	return new Response(
		JSON.stringify({
			type: status === 200 ? "sync" : "error",
			status: status === 200 ? "Success" : "",
			status_code: status === 200 ? 200 : 0,
			operation: "",
			error: status === 200 ? "" : "not authorized",
			error_code: status === 200 ? 0 : status,
			metadata,
		}),
		{ status, headers: { "content-type": "application/json" } },
	);
}

describe("instance runtime", () => {
	it("loads names once and shares the request", async () => {
		const store = createIncusStore();
		let calls = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return envelope(["/1.0/instances/web-1", "/1.0/instances/db-1"]);
		};
		try {
			await Promise.all([
				ensureInstances(store, ["name"]),
				ensureInstances(store, ["name"]),
			]);
			assert.equal(calls, 1);
			const result = readInstances(store, ["name"]);
			assert.equal(result.complete, true);
			assert.equal(result.fresh, true);
			assert.deepEqual(
				result.data?.map((instance) => instance.name),
				["web-1", "db-1"],
			);
			await ensureInstances(store, ["name"]);
			assert.equal(calls, 1);
		} finally {
			globalThis.fetch = previous;
		}
	});

	it("shows the Incus error and does not retry a client failure", async () => {
		const store = createIncusStore();
		let calls = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			calls += 1;
			return envelope(null, 403);
		};
		try {
			await ensureInstances(store, ["name", "status"]);
			await ensureInstances(store, ["name", "status"]);
			const result = readInstances(store, ["name", "status"]);
			assert.equal(calls, 1);
			assert.equal(result.available, false);
			assert.equal(result.data, undefined);
			assert.equal(result.error?.message, "not authorized");
			assert.equal(result.error?.status, 403);
		} finally {
			globalThis.fetch = previous;
		}
	});

	it("does not let a response that started before deletion restore the old instance", async () => {
		const store = createIncusStore();
		store.noteCreated("default", "web-1");
		let release: (value: Response) => void = () => {};
		const previous = globalThis.fetch;
		globalThis.fetch = () =>
			new Promise<Response>((resolve) => {
				release = resolve;
			});
		try {
			const pending = ensureInstances(store, ["name", "status"]);
			await new Promise((resolve) => setTimeout(resolve, 0));
			store.deleteInstance("default", "web-1");
			store.noteCreated("default", "web-1");
			release(
				envelope([
					{
						name: "web-1",
						status: "Running",
						description: "old",
						project: "default",
					},
				]),
			);
			await pending;
			const instance = store.getInstance("default", "web-1");
			assert.equal(instance?.fields.status, undefined);
			assert.equal(instance?.fields.description, undefined);
			assert.deepEqual(store.getCollection("default", null).names, ["web-1"]);
		} finally {
			globalThis.fetch = previous;
		}
	});
});
