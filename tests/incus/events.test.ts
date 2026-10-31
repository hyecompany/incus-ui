// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	changeInstanceState,
	putInstance,
} from "../../src/lib/incus/commands.ts";
import {
	applyLifecycleEvent,
	type LifecycleStore,
	markEventCoverage,
	parseEventMessage,
} from "../../src/lib/incus/events.ts";
import {
	cancelOperation,
	createOperationRegistry,
	type OperationRecord,
	waitForOperation,
} from "../../src/lib/incus/operations.ts";
import {
	IncusRequestError,
	type IncusResult,
	type incusRequest,
} from "../../src/lib/incus/transport.ts";

type Call = { method: string; args: unknown[] };

function createStore(): LifecycleStore & {
	calls: Call[];
	fresh: boolean;
	token: unknown;
} {
	const calls: Call[] = [];
	const store = {
		calls,
		fresh: false,
		token: undefined as unknown,
		deleteInstance(project: string, name: string) {
			calls.push({ method: "deleteInstance", args: [project, name] });
		},
		noteCreated(project: string, name: string) {
			calls.push({ method: "noteCreated", args: [project, name] });
		},
		invalidateAll() {
			calls.push({ method: "invalidateAll", args: [] });
		},
		beginRead(project: string, names: readonly string[]) {
			const token = { project, names: [...names] };
			store.token = token;
			calls.push({ method: "beginRead", args: [project, [...names]] });
			return token;
		},
		applyInstanceFields(
			token: unknown,
			project: string,
			record: { name: string; status: string },
		) {
			calls.push({
				method: "applyInstanceFields",
				args: [token, project, record],
			});
		},
		markCollectionFreshness(
			project: string,
			status: string | null,
			fresh: boolean,
		) {
			store.fresh = fresh;
			calls.push({
				method: "markCollectionFreshness",
				args: [project, status, fresh],
			});
		},
	};
	return store;
}

function createMinimalStore(): LifecycleStore & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		deleteInstance(project: string, name: string) {
			calls.push({ method: "deleteInstance", args: [project, name] });
		},
		noteCreated(project: string, name: string) {
			calls.push({ method: "noteCreated", args: [project, name] });
		},
		invalidateAll() {
			calls.push({ method: "invalidateAll", args: [] });
		},
	};
}

function lifecycle(
	action: string,
	source: string,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		type: "lifecycle",
		timestamp: "2021-03-14T00:00:00Z",
		metadata: { action, source, ...extra },
	});
}

function mustParse(data: string) {
	const event = parseEventMessage(data);
	if (!event) assert.fail("expected a lifecycle event");
	return event;
}

function envelope(
	metadata: unknown,
	operation = "",
	type: "sync" | "async" = "sync",
): IncusResult<unknown> {
	return {
		type,
		metadata,
		etag: null,
		operation,
		location: null,
		statusCode: type === "async" ? 100 : 200,
	};
}

function operationRecord(id: string, statusCode: number): OperationRecord {
	return {
		id,
		url: `/1.0/operations/${id}`,
		status: "Running",
		statusCode,
		err: "",
		mayCancel: true,
		initiatedHere: true,
		monitoring: true,
	};
}

describe("lifecycle messages", () => {
	it("reads the project from the instance source and defaults it when absent", () => {
		const named = mustParse(
			lifecycle("instance-deleted", "/1.0/instances/web-1?project=production"),
		);
		assert.equal(named.action, "instance-deleted");
		assert.equal(named.project, "production");
		assert.equal(named.name, "web-1");

		const fallback = mustParse(
			lifecycle("instance-started", "/1.0/instances/web-1"),
		);
		assert.equal(fallback.project, "default");
		assert.equal(fallback.name, "web-1");
	});

	it("ignores frames that are not an instance lifecycle event", () => {
		assert.equal(parseEventMessage("not-json"), null);
		assert.equal(
			parseEventMessage(
				JSON.stringify({ type: "logging", metadata: { message: "nope" } }),
			),
			null,
		);
		assert.equal(
			parseEventMessage(
				JSON.stringify({ type: "operation", metadata: { id: "op" } }),
			),
			null,
		);
		assert.equal(
			parseEventMessage(
				lifecycle(
					"instance-snapshot-created",
					"/1.0/instances/web-1/snapshots/snap",
				),
			),
			null,
		);
	});
});

describe("lifecycle application", () => {
	it("deletes the instance named by an instance-deleted event", () => {
		const store = createStore();
		applyLifecycleEvent(
			store,
			mustParse(
				lifecycle(
					"instance-deleted",
					"/1.0/instances/web-1?project=production",
				),
			),
		);
		assert.deepEqual(store.calls, [
			{ method: "deleteInstance", args: ["production", "web-1"] },
		]);
	});

	it("drops the old name and notes the new name when a rename includes old_name", () => {
		const store = createStore();
		applyLifecycleEvent(
			store,
			mustParse(
				lifecycle(
					"instance-renamed",
					"/1.0/instances/web-2?project=production",
					{
						old_name: "web-1",
					},
				),
			),
		);
		assert.deepEqual(store.calls, [
			{ method: "deleteInstance", args: ["production", "web-1"] },
			{ method: "noteCreated", args: ["production", "web-2"] },
		]);
	});

	it("reads old_name from lifecycle context when it is not a top-level field", () => {
		const store = createStore();
		applyLifecycleEvent(
			store,
			mustParse(
				lifecycle("instance-renamed", "/1.0/instances/web-2", {
					context: { old_name: "web-1" },
				}),
			),
		);
		assert.deepEqual(store.calls, [
			{ method: "deleteInstance", args: ["default", "web-1"] },
			{ method: "noteCreated", args: ["default", "web-2"] },
		]);
	});

	it("only invalidates when a rename does not include old_name", () => {
		const store = createStore();
		applyLifecycleEvent(
			store,
			mustParse(
				lifecycle(
					"instance-renamed",
					"/1.0/instances/web-2?project=production",
				),
			),
		);
		assert.deepEqual(store.calls, [{ method: "invalidateAll", args: [] }]);
	});

	it("notes a created instance and marks the unfiltered collection stale", () => {
		const store = createStore();
		applyLifecycleEvent(
			store,
			mustParse(
				lifecycle(
					"instance-created",
					"/1.0/instances/web-1?project=production",
				),
			),
		);
		assert.equal(store.fresh, false);
		assert.deepEqual(store.calls, [
			{ method: "noteCreated", args: ["production", "web-1"] },
			{ method: "markCollectionFreshness", args: ["production", null, false] },
		]);
	});

	it("invalidates after noting a create when the store cannot mark freshness", () => {
		const store = createMinimalStore();
		applyLifecycleEvent(
			store,
			mustParse(lifecycle("instance-created", "/1.0/instances/web-1")),
		);
		assert.deepEqual(store.calls, [
			{ method: "noteCreated", args: ["default", "web-1"] },
			{ method: "invalidateAll", args: [] },
		]);
	});

	it("applies running and stopped status without refetching the collection", () => {
		const store = createStore();
		applyLifecycleEvent(
			store,
			mustParse(
				lifecycle(
					"instance-started",
					"/1.0/instances/web-1?project=production",
				),
			),
		);
		applyLifecycleEvent(
			store,
			mustParse(
				lifecycle(
					"instance-stopped",
					"/1.0/instances/web-1?project=production",
				),
			),
		);
		applyLifecycleEvent(
			store,
			mustParse(
				lifecycle(
					"instance-shutdown",
					"/1.0/instances/web-1?project=production",
				),
			),
		);
		const token = { project: "production", names: ["web-1"] };
		assert.deepEqual(store.calls, [
			{ method: "beginRead", args: ["production", ["web-1"]] },
			{
				method: "applyInstanceFields",
				args: [token, "production", { name: "web-1", status: "Running" }],
			},
			{ method: "beginRead", args: ["production", ["web-1"]] },
			{
				method: "applyInstanceFields",
				args: [token, "production", { name: "web-1", status: "Stopped" }],
			},
			{ method: "beginRead", args: ["production", ["web-1"]] },
			{
				method: "applyInstanceFields",
				args: [token, "production", { name: "web-1", status: "Stopped" }],
			},
		]);
		assert.equal(store.calls[5]?.args[0], store.token);
	});

	it("invalidates a status change when fields cannot be applied", () => {
		const store = createMinimalStore();
		applyLifecycleEvent(
			store,
			mustParse(lifecycle("instance-started", "/1.0/instances/web-1")),
		);
		applyLifecycleEvent(
			store,
			mustParse(lifecycle("instance-updated", "/1.0/instances/web-1")),
		);
		assert.deepEqual(store.calls, [
			{ method: "invalidateAll", args: [] },
			{ method: "invalidateAll", args: [] },
		]);
	});
});

describe("event coverage", () => {
	it("invalidates when coverage drops and does not mark the cache fresh when it returns", () => {
		const store = createStore();
		store.fresh = false;
		markEventCoverage(store, false);
		assert.equal(
			store.calls.filter((call) => call.method === "invalidateAll").length,
			1,
		);
		store.fresh = false;
		markEventCoverage(store, true);
		assert.equal(
			store.calls.filter((call) => call.method === "invalidateAll").length,
			1,
		);
		assert.equal(store.fresh, false);
		assert.equal(
			store.calls.some((call) => call.method === "markCollectionFreshness"),
			false,
		);
	});
});

describe("operation registry", () => {
	it("drops local records on clear without cancelling them", () => {
		const registry = createOperationRegistry();
		let notifications = 0;
		const stop = registry.subscribe(() => {
			notifications += 1;
		});
		registry.register(operationRecord("op-1", 103));
		assert.equal(registry.list().length, 1);
		assert.equal(registry.get("op-1")?.statusCode, 103);
		registry.clear();
		assert.deepEqual(registry.list(), []);
		assert.equal(registry.get("op-1"), undefined);
		assert.equal(notifications, 2);
		stop();
	});
});

describe("operation polling", () => {
	it("stops at status code 200 and surfaces err when the operation fails", async () => {
		const registry = createOperationRegistry();
		registry.register(operationRecord("op-1", 105));
		let polls = 0;
		const request = (async (path: string, init?: { method?: string }) => {
			assert.equal(path, "/1.0/operations/op-1");
			assert.equal(init?.method, "GET");
			polls += 1;
			if (polls === 1) {
				return envelope({
					status: "Running",
					status_code: 103,
					err: "",
					may_cancel: true,
				});
			}
			if (polls === 2) {
				assert.equal(registry.get("op-1")?.statusCode, 103);
				return envelope({
					status: "Success",
					status_code: 200,
					err: "",
					may_cancel: false,
				});
			}
			throw new Error("polled after the operation finished");
		}) as typeof incusRequest;

		const finished = await waitForOperation(registry, "op-1", { request });
		assert.equal(finished.statusCode, 200);
		assert.equal(finished.status, "Success");
		assert.equal(finished.err, "");
		assert.equal(polls, 2);

		const failedRegistry = createOperationRegistry();
		failedRegistry.register(operationRecord("op-2", 103));
		const failed = await waitForOperation(failedRegistry, "op-2", {
			request: (async () =>
				envelope({
					status: "Failure",
					status_code: 400,
					err: "instance is busy",
					may_cancel: false,
				})) as typeof incusRequest,
		});
		assert.equal(failed.statusCode, 400);
		assert.equal(failed.err, "instance is busy");
		assert.equal(failedRegistry.get("op-2")?.statusCode, 400);
	});

	it("treats operation status 401 as cancelled rather than an authentication failure", async () => {
		const registry = createOperationRegistry();
		registry.register(operationRecord("op-1", 103));
		const finished = await waitForOperation(registry, "op-1", {
			request: (async () =>
				envelope({
					status: "Cancelled",
					status_code: 401,
					err: "",
					may_cancel: false,
				})) as typeof incusRequest,
		});
		assert.equal(finished.statusCode, 401);
		assert.equal(finished.monitoring, true);
	});

	it("clears monitoring when a poll is rejected and leaves the last status code", async () => {
		const registry = createOperationRegistry();
		registry.register(operationRecord("op-1", 103));
		const error = new IncusRequestError("not authorized", 403, 403);
		await assert.rejects(
			() =>
				waitForOperation(registry, "op-1", {
					request: (async () => {
						throw error;
					}) as typeof incusRequest,
				}),
			(caught: unknown) => caught === error,
		);
		const record = registry.get("op-1");
		assert.equal(record?.monitoring, false);
		assert.equal(record?.statusCode, 103);
		assert.equal(record?.err, "");
	});

	it("treats a missing operation as already gone when cancelling", async () => {
		const registry = createOperationRegistry();
		registry.register(operationRecord("op-1", 103));
		let method = "";
		await cancelOperation(registry, "op-1", (async (
			_path: string,
			init?: { method?: string },
		) => {
			method = init?.method ?? "GET";
			throw new IncusRequestError("not found", 404, 404);
		}) as typeof incusRequest);
		assert.equal(method, "DELETE");
		assert.equal(registry.get("op-1")?.statusCode, 103);

		await assert.rejects(
			() =>
				cancelOperation(registry, "op-1", (async () => {
					throw new IncusRequestError("unavailable", 500, 500);
				}) as typeof incusRequest),
			(error: unknown) =>
				error instanceof IncusRequestError && error.status === 500,
		);
	});
});

describe("instance commands", () => {
	it("registers the state-change operation before resolving and does not wait yet", async () => {
		const registry = createOperationRegistry();
		const calls: { path: string; method: string; body: unknown }[] = [];
		const request = (async (
			path: string,
			init?: { method?: string; body?: unknown },
		) => {
			calls.push({ path, method: init?.method ?? "GET", body: init?.body });
			return envelope(
				{ status: "Running", status_code: 103, err: "", may_cancel: true },
				"/1.0/operations/op-1",
				"async",
			);
		}) as typeof incusRequest;

		const result = await changeInstanceState("web-1", "start", {
			project: "production",
			registry,
			request,
		});
		assert.equal(result.accepted, true);
		assert.equal(result.operation.id, "op-1");
		assert.equal(result.operation.url, "/1.0/operations/op-1");
		assert.deepEqual(calls, [
			{
				path: "/1.0/instances/web-1/state?project=production",
				method: "POST",
				body: { action: "start", timeout: 30, force: false, stateful: false },
			},
		]);
		const record = registry.get("op-1");
		assert.equal(record?.initiatedHere, true);
		assert.equal(record?.monitoring, true);
		assert.equal(record?.statusCode, 103);
		assert.equal(calls.length, 1);

		const defaultProject = await changeInstanceState("web-1", "restart", {
			project: "default",
			registry: createOperationRegistry(),
			request,
		});
		assert.equal(defaultProject.operation.id, "op-1");
		assert.equal(calls[1]?.path, "/1.0/instances/web-1/state");
		assert.equal(calls.length, 2);
	});

	it("sends If-Match when putting an instance and lets a precondition failure propagate", async () => {
		let seenPath = "";
		let seenMethod = "";
		let seenBody: unknown;
		let seenMatch: string | null = null;
		const request = (async (
			path: string,
			init?: { method?: string; body?: unknown; headers?: HeadersInit },
		) => {
			seenPath = path;
			seenMethod = init?.method ?? "GET";
			seenBody = init?.body;
			seenMatch = new Headers(init?.headers).get("if-match");
			return envelope({ name: "web-1" });
		}) as typeof incusRequest;

		const result = await putInstance(
			"web-1",
			{ description: "edge" },
			'"etag-1"',
			{
				project: "production",
				request,
			},
		);
		assert.equal(result.metadata && typeof result.metadata === "object", true);
		assert.equal(seenPath, "/1.0/instances/web-1?project=production");
		assert.equal(seenMethod, "PUT");
		assert.deepEqual(seenBody, { description: "edge" });
		assert.equal(seenMatch, '"etag-1"');

		const missing = await putInstance("web-1", {}, "etag", {
			request: (async (path: string) => {
				seenPath = path;
				return envelope({});
			}) as typeof incusRequest,
		});
		assert.equal(missing.type, "sync");
		assert.equal(seenPath, "/1.0/instances/web-1");

		const precondition = new IncusRequestError("precondition failed", 412, 412);
		await assert.rejects(
			() =>
				putInstance("web-1", {}, '"etag-1"', {
					request: (async () => {
						throw precondition;
					}) as typeof incusRequest,
				}),
			(error: unknown) => error === precondition,
		);
	});
});
