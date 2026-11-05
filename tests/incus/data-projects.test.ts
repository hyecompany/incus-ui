// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DataCore } from "../../src/lib/incus/data/core.ts";
import { connectEvents, coverageFor, type EventSource } from "../../src/lib/incus/data/coverage.ts";
import { createProjectsApi, type ProjectsApi } from "../../src/lib/incus/data/projects.ts";
import type { IncusEvent, ScopeStatus, Subscription } from "../../src/lib/incus/events/types.ts";
import { ALL_PROJECTS } from "../../src/lib/incus/project-scope.ts";

/* A fake Incus that records every request and can hold responses. */
class FakeIncus {
	projects = new Map<string, { description: string; config: Record<string, string> }>();
	requests: string[] = [];
	failWith: { status: number; error: string } | null = null;
	private holding = false;
	private held: Array<() => void> = [];

	hold() {
		this.holding = true;
	}
	release() {
		this.holding = false;
		for (const resume of this.held.splice(0)) resume();
	}

	fetch = async (input: unknown): Promise<Response> => {
		const url = String(input);
		this.requests.push(url);
		if (this.holding) await new Promise<void>((resume) => this.held.push(resume));
		const reply = (status: number, body: unknown) =>
			new Response(JSON.stringify(body), { status });
		if (this.failWith) {
			return reply(this.failWith.status, {
				type: "error",
				error_code: this.failWith.status,
				error: this.failWith.error,
			});
		}
		const sync = (metadata: unknown) => reply(200, { type: "sync", status_code: 200, metadata });
		const object = (name: string) => ({ name, ...this.projects.get(name), used_by: [] });
		if (url === "/1.0/projects") {
			return sync([...this.projects.keys()].map((n) => `/1.0/projects/${encodeURIComponent(n)}`));
		}
		if (url === "/1.0/projects?recursion=1") return sync([...this.projects.keys()].map(object));
		const name = decodeURIComponent(url.slice("/1.0/projects/".length));
		if (!this.projects.has(name)) {
			return reply(404, { type: "error", error_code: 404, error: "Project not found" });
		}
		return sync(object(name));
	};
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

const lifecycle = (action: string, name: string, context?: Record<string, unknown>): IncusEvent => ({
	type: "lifecycle",
	timestamp: "t",
	metadata: { action, source: `/1.0/projects/${encodeURIComponent(name)}`, context: context ?? {} },
});

let incus: FakeIncus;
let realFetch: typeof fetch;
let core: DataCore;
let api: ProjectsApi;
let clock: number;
const stops: Array<() => void> = [];

beforeEach(() => {
	incus = new FakeIncus();
	incus.projects.set("default", { description: "Default Incus project", config: { "features.images": "true" } });
	incus.projects.set("web", { description: "Web", config: {} });
	realFetch = globalThis.fetch;
	globalThis.fetch = incus.fetch as typeof fetch;
	clock = 1_000;
	core = new DataCore({ now: () => clock, retryAfterMs: 10 });
	api = createProjectsApi(core);
	core.setCoverage("connected");
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	core.dispose();
	globalThis.fetch = realFetch;
});

function mount<R>(watch: { subscribe(cb: () => void): () => void; getSnapshot(): R }) {
	let renders = 0;
	stops.push(watch.subscribe(() => renders++));
	return { get: () => watch.getSnapshot(), renders: () => renders };
}

describe("requests are planned from what consumers need", () => {
	it("names only: one URL-list request, complete membership", async () => {
		const list = mount(api.watchList(["name"]));
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/projects"]);
		const r = list.get();
		assert.deepEqual(r.data, [{ name: "default" }, { name: "web" }]);
		assert.equal(r.complete, true);
		assert.equal(r.available, true);
		assert.equal(r.fresh, true);
		assert.equal(r.fetching, false);
	});

	it("consumers needing names and details in the same tick share one recursive request", async () => {
		mount(api.watchList(["name"]));
		const details = mount(api.watchList(["name", "description"]));
		mount(api.watchList(["name"]));
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/projects?recursion=1"]);
		assert.deepEqual(details.get().data, [
			{ name: "default", description: "Default Incus project" },
			{ name: "web", description: "Web" },
		]);
	});

	it("data only contains the selected fields", async () => {
		const list = mount(api.watchList(["description"]));
		await flush();
		assert.deepEqual(Object.keys(list.get().data?.[0] ?? {}).sort(), ["description", "name"]);
	});

	it("existence of one project is derived from complete membership, with no request", async () => {
		mount(api.watchList(["name"]));
		await flush();
		incus.requests = [];
		const web = mount(api.watch("web", ["name"]));
		const gone = mount(api.watch("nope", ["name"]));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.equal(web.get().exists, true);
		assert.equal(gone.get().exists, false);
		assert.equal(gone.get().available, true);
	});

	it("details already learned from the list satisfy a single-project consumer without a GET", async () => {
		mount(api.watchList(["config"]));
		await flush();
		incus.requests = [];
		const one = mount(api.watch("default", ["config"]));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.deepEqual(one.get().data, { name: "default", config: { "features.images": "true" } });
	});

	it("a single project with details uses its own endpoint; 404 is known absence", async () => {
		const one = mount(api.watch("web", ["description"]));
		const gone = mount(api.watch("gone", ["description"]));
		await flush();
		assert.deepEqual(incus.requests.sort(), ["/1.0/projects/gone", "/1.0/projects/web"]);
		assert.equal(one.get().data?.description, "Web");
		assert.equal(gone.get().exists, false);
		assert.equal(gone.get().error, null);
	});

	it("never sends the header's project scope on project requests", async () => {
		mount(api.watchList(["name", "config"]));
		mount(api.watch("web", ["name"]));
		await flush();
		assert.ok(incus.requests.every((url) => !url.includes("project=") && !url.includes("all-projects")));
	});
});

describe("events change the store directly", () => {
	async function warm(fields: Parameters<ProjectsApi["watchList"]>[0]) {
		const list = mount(api.watchList(fields));
		await flush();
		incus.requests = [];
		return list;
	}

	it("project-created adds the member without any request for name-only consumers", async () => {
		const list = await warm(["name"]);
		incus.projects.set("new", { description: "N", config: {} });
		core.ingest(lifecycle("project-created", "new"));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.deepEqual(list.get().data?.map((p) => p.name), ["default", "new", "web"]);
		assert.equal(list.get().complete, true);
	});

	it("project-created fetches only that project when its details are needed", async () => {
		const list = await warm(["name", "description"]);
		incus.projects.set("new", { description: "N", config: {} });
		core.ingest(lifecycle("project-created", "new"));
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/projects/new"]);
		assert.deepEqual(list.get().data?.find((p) => p.name === "new"), { name: "new", description: "N" });
	});

	it("project-deleted removes the member and its fields, with no request", async () => {
		const list = await warm(["name", "description"]);
		incus.projects.delete("web");
		core.ingest(lifecycle("project-deleted", "web"));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.deepEqual(list.get().data?.map((p) => p.name), ["default"]);
		const web = mount(api.watch("web", ["name"]));
		await flush();
		assert.equal(web.get().exists, false);
		assert.deepEqual(incus.requests, []);
	});

	it("project-renamed moves the identity and keeps known details, with no request", async () => {
		const list = await warm(["name", "description"]);
		core.ingest(lifecycle("project-renamed", "site", { old_name: "web" }));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.deepEqual(list.get().data, [
			{ name: "default", description: "Default Incus project" },
			{ name: "site", description: "Web" },
		]);
	});

	it("project-updated revalidates only that project, only for consumers of its details", async () => {
		const names = await warm(["name"]);
		core.ingest(lifecycle("project-updated", "web"));
		await flush();
		assert.deepEqual(incus.requests, [], "name-only consumers do not trigger a fetch");

		const details = mount(api.watchList(["description"]));
		await flush();
		incus.requests = [];
		incus.projects.set("web", { description: "Changed", config: {} });
		core.ingest(lifecycle("project-updated", "web"));
		assert.equal(details.get().fresh, false, "updated details are marked as needing validation");
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/projects/web"]);
		assert.equal(details.get().data?.find((p) => p.name === "web")?.description, "Changed");
		assert.equal(details.get().fresh, true);
		assert.equal(names.get().fresh, true);
	});

	it("unrelated changes do not re-render consumers", async () => {
		const names = await warm(["name"]);
		const before = names.renders();
		core.ingest(lifecycle("project-updated", "web"));
		core.ingest({
			type: "lifecycle",
			timestamp: "t",
			metadata: { action: "instance-created", source: "/1.0/instances/x" },
		});
		await flush();
		assert.equal(names.renders(), before);
	});
});

describe("reads, events and generations reconcile safely", () => {
	it("a deletion during an in-flight list is not undone by the older response", async () => {
		incus.hold();
		const list = mount(api.watchList(["name"]));
		await flush();
		core.ingest(lifecycle("project-deleted", "web"));
		incus.release(); // the response still contains "web"
		await flush();
		assert.deepEqual(list.get().data?.map((p) => p.name), ["default"]);
	});

	it("delete then re-create during a read: the old read's fields are not applied to the new project", async () => {
		incus.hold();
		const one = mount(api.watch("web", ["description"]));
		await flush();
		core.ingest(lifecycle("project-deleted", "web"));
		core.ingest(lifecycle("project-created", "web"));
		incus.projects.set("web", { description: "Brand new", config: {} });
		incus.release(); // races: old read returns, then a fresh GET follows
		await flush();
		incus.release();
		await flush();
		assert.equal(one.get().data?.description, "Brand new");
		assert.equal(incus.requests.filter((u) => u === "/1.0/projects/web").length, 2);
	});

	it("equivalent requirements share one in-flight request; releasing one consumer does not cancel it", async () => {
		incus.hold();
		const a = api.watchList(["name"]).subscribe(() => undefined);
		const b = mount(api.watchList(["name"]));
		await flush();
		a();
		incus.release();
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/projects"]);
		assert.equal(b.get().available, true);
	});
});

describe("coverage and freshness", () => {
	it("interruption keeps data usable but not fresh, and waits for restore to reconcile", async () => {
		const list = mount(api.watchList(["name", "description"]));
		await flush();
		incus.requests = [];
		core.setCoverage("interrupted");
		await flush();
		assert.equal(list.get().fresh, false);
		assert.equal(list.get().available, true);
		assert.deepEqual(incus.requests, [], "no fetch while interrupted");

		core.setCoverage("connected");
		assert.equal(list.get().fresh, false, "restoring the connection alone is not freshness");
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/projects?recursion=1"]);
		assert.equal(list.get().fresh, true);
	});

	it("data fetched before coverage starts is reconciled once it does", async () => {
		core.setCoverage("unavailable");
		const list = mount(api.watchList(["name"]));
		await flush();
		core.setCoverage("connected");
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/projects", "/1.0/projects"]);
		assert.equal(list.get().fresh, true);
	});

	it("without event coverage, freshness falls back to age", async () => {
		core.setCoverage("unavailable");
		const list = mount(api.watchList(["name"]));
		await flush();
		assert.equal(list.get().fresh, true);
		clock += 31_000;
		core.revalidate();
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/projects", "/1.0/projects"]);
	});

	it("connectEvents maps the shared connection to coverage and feeds lifecycle events", async () => {
		const seen: {
			listener?: (s: ScopeStatus) => void;
			subscription?: Subscription;
		} = {};
		const source: EventSource = {
			subscribe(sub) {
				seen.subscription = sub;
				return () => undefined;
			},
			getStatus: () => ({ scope: ALL_PROJECTS, stream: "core", state: "connecting", generation: 0 }),
			onStatus(cb) {
				seen.listener = cb;
				return () => undefined;
			},
		};
		const fresh = new DataCore();
		createProjectsApi(fresh);
		const disconnect = connectEvents(fresh, source);
		assert.equal(fresh.coverage.state, "unavailable");
		seen.listener?.({ scope: ALL_PROJECTS, stream: "core", state: "connected", generation: 0 });
		assert.equal(fresh.coverage.state, "connected");
		seen.listener?.({ scope: ALL_PROJECTS, stream: "logging", state: "failed", generation: 0 });
		assert.equal(fresh.coverage.state, "connected", "the logging stream does not affect coverage");
		seen.listener?.({ scope: ALL_PROJECTS, stream: "core", state: "reconnecting", generation: 0 });
		assert.equal(fresh.coverage.state, "interrupted");
		assert.deepEqual(seen.subscription?.types, ["lifecycle", "operation"]);
		disconnect();
		fresh.dispose();
		assert.equal(coverageFor("failed", "connected"), "unavailable");
	});
});

describe("failures keep their meaning", () => {
	it("a failed refresh keeps existing data and reports the error", async () => {
		const list = mount(api.watchList(["name"]));
		await flush();
		incus.failWith = { status: 500, error: "boom" };
		api.refreshList(["name"]);
		await flush();
		assert.deepEqual(list.get().data?.map((p) => p.name), ["default", "web"]);
		assert.equal(list.get().error?.kind, "server");
	});

	it("forbidden is reported and not retried automatically", async () => {
		incus.failWith = { status: 403, error: "not allowed" };
		const list = mount(api.watchList(["name"]));
		await flush();
		await new Promise((r) => setTimeout(r, 30));
		await flush();
		assert.equal(list.get().error?.kind, "forbidden");
		assert.equal(list.get().data, undefined, "no collection is invented");
		assert.equal(incus.requests.length, 1);
	});

	it("transient failures retry with backoff, then recover", async () => {
		incus.failWith = { status: 503, error: "busy" };
		const list = mount(api.watchList(["name"]));
		await flush();
		incus.failWith = null;
		await new Promise((r) => setTimeout(r, 30));
		await flush();
		assert.equal(list.get().error, null);
		assert.equal(list.get().available, true);
		assert.equal(incus.requests.length, 2);
	});
});

describe("imperative consumers use the same machinery", () => {
	it("list() resolves with selected fields and shares state with hooks", async () => {
		const result = await api.list(["description"]);
		assert.deepEqual(result.data?.map((p) => p.description), ["Default Incus project", "Web"]);
		const one = await api.get("web", ["description"]);
		assert.equal(one.data?.description, "Web");
		assert.deepEqual(incus.requests, ["/1.0/projects?recursion=1"]);
		// Field selection is reflected in the types:
		const names = await api.list(["name"]);
		// @ts-expect-error description was not selected
		void names.data?.[0]?.description;
	});
});
