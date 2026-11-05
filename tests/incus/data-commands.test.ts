// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { incusFetch } from "../../src/lib/incus/client.ts";
import { DataCore } from "../../src/lib/incus/data/core.ts";
import { createInstancesApi, type InstancesApi } from "../../src/lib/incus/data/instances.ts";
import { OperationsRegistry } from "../../src/lib/incus/data/operations.ts";
import { createProjectsApi, type ProjectsApi } from "../../src/lib/incus/data/projects.ts";
import type { IncusEvent } from "../../src/lib/incus/events/types.ts";
import { FakeIncus, flush, mount } from "./fake-incus.ts";

const WEB = { project: "default", name: "web" };
const opEvent = (id: string, status: string): IncusEvent => ({
	type: "operation",
	timestamp: "t",
	project: "default",
	metadata: { id, status, description: "Op", resources: {}, may_cancel: true },
});

let incus: FakeIncus;
let realFetch: typeof fetch;
let core: DataCore;
let api: InstancesApi;
let projects: ProjectsApi;
const stops: Array<() => void> = [];

beforeEach(() => {
	incus = new FakeIncus();
	incus.add("default", "web");
	realFetch = globalThis.fetch;
	globalThis.fetch = incus.fetch as typeof fetch;
	core = new DataCore();
	api = createInstancesApi(core);
	projects = createProjectsApi(core);
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	core.dispose();
	globalThis.fetch = realFetch;
});

describe("transport", () => {
	it("returns the ETag and the operation of an async response", async () => {
		const got = await incusFetch("/1.0/instances/web", { query: { project: "default" } });
		assert.equal(got.etag, incus.etag("default/web"));
		const accepted = await incusFetch("/1.0/instances/web/state", {
			method: "PUT",
			query: { project: "default" },
			body: { action: "stop" },
		});
		assert.equal(accepted.status, 202);
		assert.equal(accepted.operation?.id, "op1");
	});

	it("maps 412 to a conflict", async () => {
		await assert.rejects(
			incusFetch("/1.0/instances/web", { method: "PUT", query: { project: "default" }, body: {}, ifMatch: '"old"' }),
			(error: { kind: string }) => error.kind === "conflict",
		);
	});
});

describe("ETag-conditional updates", () => {
	it("PUTs the whole writable baseline with the draft's ETag", async () => {
		const draft = await api.edit(WEB);
		const { operation } = await api.save(draft, (b) => ({ ...b, description: "new" }));
		const put = incus.bodies.find((b) => b.method === "PUT");
		assert.equal(put?.ifMatch, draft.etag);
		// Fields the consumer did not touch are preserved.
		assert.deepEqual((put?.body as { config: unknown }).config, { "limits.cpu": "2" });
		assert.ok(operation);
	});

	it("a later read does not replace the draft's precondition: the conflict surfaces", async () => {
		const draft = await api.edit(WEB);
		incus.revision += 1; // someone else changed it
		await api.get(WEB, ["config"]);
		await assert.rejects(
			api.save(draft, (b) => b),
			(error: { kind: string }) => error.kind === "conflict",
		);
	});

	it("edit() updates shared state like any other read", async () => {
		const one = mount(api.watch(WEB, ["description"]), stops);
		await api.edit(WEB);
		assert.equal(one.get().available, true);
	});

	it("projects: conditional PUT, then the cached details are revalidated", async () => {
		const one = mount(projects.watch("default", ["description"]), stops);
		await flush();
		const draft = await projects.edit("default");
		await projects.save(draft, (b) => ({ ...b, description: "changed" }));
		await flush();
		assert.equal(one.get().data?.description, "changed");
		assert.equal(one.get().fresh, true);
	});
});

describe("operations", () => {
	it("registers the operation before returning the handle", async () => {
		incus.finishOperationsAs = null;
		const { operation } = await api.action(WEB, "stop");
		assert.ok(operation);
		const record = core.operations.get(operation.id);
		assert.equal(record?.origin, "local");
		assert.equal(record?.status, "Running");
	});

	it("an event that arrives before the response is not lost", async () => {
		incus.finishOperationsAs = null;
		core.setCoverage("connected");
		core.ingest(opEvent("op1", "Success"));
		const { operation } = await api.action(WEB, "start");
		assert.equal(operation?.get().status, "Success");
		assert.equal(operation?.get().origin, "local");
		assert.equal((await operation?.wait())?.status, "Success");
	});

	it("follows events while covered, distinct from observed operations", async () => {
		incus.finishOperationsAs = null;
		core.setCoverage("connected");
		core.ingest(opEvent("other", "Running"));
		const { operation } = await api.action(WEB, "stop");
		const waited = operation?.wait();
		core.ingest(opEvent(operation?.id as string, "Success"));
		assert.equal((await waited)?.status, "Success");
		assert.equal(core.operations.get("other")?.origin, "observed");
	});

	it("without event coverage, long-polls /wait", async () => {
		incus.finishOperationsAs = null;
		const { operation } = await api.action(WEB, "stop");
		const done = await operation?.wait();
		assert.equal(done?.status, "Success");
		assert.ok(incus.requests.some((r) => r.startsWith("/1.0/operations/op1/wait")));
	});

	it("losing the operation is not reported as a server failure", async () => {
		incus.finishOperationsAs = null;
		core.setCoverage("connected");
		const { operation } = await api.action(WEB, "stop");
		// Coverage drops and the server has forgotten the operation meanwhile.
		incus.operations.clear();
		core.setCoverage("interrupted");
		await assert.rejects(operation?.wait() as Promise<unknown>, /outcome is unknown/);
		assert.equal(operation?.get().monitoring, "lost");
		assert.notEqual(operation?.get().status, "Failure");
	});

	it("supports cancellation", async () => {
		incus.finishOperationsAs = null;
		core.setCoverage("connected");
		const { operation } = await api.action(WEB, "stop");
		await operation?.cancel();
		assert.ok(incus.requests.includes("DELETE /1.0/operations/op1?project=default"));
	});

	it("completion revalidates the affected data instead of labeling it current", async () => {
		const one = mount(api.watch(WEB, ["status"]), stops);
		await flush();
		assert.equal(one.get().data?.status, "Running");
		const { operation } = await api.action(WEB, "stop");
		await operation?.wait();
		await flush();
		assert.equal(one.get().data?.status, "Stopped");
		assert.equal(operation?.get().reconciling, false);
	});

	it("keeps tracking after the consumer is gone, and clear() forgets records only", async () => {
		incus.finishOperationsAs = null;
		core.setCoverage("connected");
		const { operation } = await api.action(WEB, "stop");
		core.clear();
		assert.equal(core.operations.get(operation?.id as string), undefined);
		assert.equal(incus.operations.get(operation?.id as string)?.status, "Running");
	});

	it("deleting marks the instance absent once the operation succeeds", async () => {
		const one = mount(api.watch(WEB, ["name"]), stops);
		await flush();
		const { operation } = await api.delete(WEB);
		await operation?.wait();
		await flush();
		assert.equal(one.get().exists, false);
	});

	it("bounds retention of finished operations", () => {
		const registry = new OperationsRegistry({ maxRetained: 2 });
		registry.setCoverage(true);
		for (const id of ["a", "b", "c", "d"]) {
			registry.ingest(opEvent(id, "Running"));
			registry.ingest(opEvent(id, "Success"));
		}
		assert.ok(registry.list().length <= 2);
	});
});

describe("commands with unknown outcomes", () => {
	it("a connection failure after sending is reported as unknown, not replayed", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new TypeError("network down");
		}) as typeof fetch;
		await assert.rejects(api.action(WEB, "stop"), /outcome is unknown/);
		assert.equal(calls, 1);
	});
});
