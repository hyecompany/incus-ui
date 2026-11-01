// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DataCore } from "../../src/lib/incus/data/core.ts";
import { createInstancesApi, type InstancesApi } from "../../src/lib/incus/data/instances.ts";
import type { IncusEvent } from "../../src/lib/incus/events/types.ts";
import { ALL_PROJECTS, type ProjectScope } from "../../src/lib/incus/project-scope.ts";

type Row = { status: string; statusCode: number; description: string };

/* A fake Incus implementing instance scopes, URL formats and status filters. */
class FakeIncus {
	instances = new Map<string, Row>(); // key "project/name"
	requests: string[] = [];
	private holding = false;
	private held: Array<() => void> = [];

	add(project: string, name: string, status = "Running", description = "") {
		this.instances.set(`${project}/${name}`, {
			status,
			statusCode: status === "Running" ? 103 : 102,
			description,
		});
	}
	hold() {
		this.holding = true;
	}
	release() {
		this.holding = false;
		for (const resume of this.held.splice(0)) resume();
	}

	fetch = async (input: unknown): Promise<Response> => {
		const raw = String(input);
		this.requests.push(decodeURIComponent(raw.replaceAll("+", " ")));
		if (this.holding) await new Promise<void>((resume) => this.held.push(resume));
		const url = new URL(raw, "http://incus");
		const q = url.searchParams;
		const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
		const sync = (metadata: unknown) => reply(200, { type: "sync", status_code: 200, metadata });
		const object = (key: string) => {
			const [project = "", name = ""] = key.split("/");
			const row = this.instances.get(key) as Row;
			return {
				name,
				project,
				status: row.status,
				status_code: row.statusCode,
				type: "container",
				location: "none",
				architecture: "x86_64",
				description: row.description,
				created_at: "",
				last_used_at: "",
				profiles: ["default"],
				config: { "volatile.secret": "x" },
			};
		};
		if (url.pathname === "/1.0/instances") {
			const project = q.get("project") ?? "default";
			const all = q.get("all-projects") === "true";
			const filter = q.get("filter");
			const wanted = filter?.match(/^status eq (\w+)$/)?.[1]?.toLowerCase();
			const keys = [...this.instances.keys()].filter((key) => {
				const [p] = key.split("/");
				const row = this.instances.get(key) as Row;
				return (all || p === project) && (!wanted || row.status.toLowerCase() === wanted);
			});
			if (q.get("recursion") === "1") return sync(keys.map(object));
			return sync(
				keys.map((key) => {
					const [p = "", n = ""] = key.split("/");
					return `/1.0/instances/${n}${p === "default" ? "" : `?project=${p}`}`;
				}),
			);
		}
		const name = decodeURIComponent(url.pathname.slice("/1.0/instances/".length));
		const key = `${q.get("project") ?? "default"}/${name}`;
		if (!this.instances.has(key)) {
			return reply(404, { type: "error", error_code: 404, error: "Instance not found" });
		}
		return sync(object(key));
	};
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

function event(action: string, name: string, project = "default", context: Record<string, unknown> = {}): IncusEvent {
	const query = project === "default" ? "" : `?project=${project}`;
	return {
		type: "lifecycle",
		timestamp: "t",
		metadata: { action, source: `/1.0/instances/${name}${query}`, context },
	};
}

const DEFAULT: ProjectScope = { kind: "project", name: "default" };
const WEB: ProjectScope = { kind: "project", name: "web" };

let incus: FakeIncus;
let realFetch: typeof fetch;
let core: DataCore;
let api: InstancesApi;
const stops: Array<() => void> = [];

beforeEach(() => {
	incus = new FakeIncus();
	incus.add("default", "db", "Running", "database");
	incus.add("default", "old", "Stopped");
	incus.add("web", "nginx", "Running");
	realFetch = globalThis.fetch;
	globalThis.fetch = incus.fetch as typeof fetch;
	core = new DataCore({ now: () => 1_000 });
	api = createInstancesApi(core);
	core.setCoverage("connected");
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	core.dispose();
	globalThis.fetch = realFetch;
});

function mount<R>(watch: { subscribe(cb: () => void): () => void; getSnapshot(): R }) {
	stops.push(watch.subscribe(() => undefined));
	return { get: () => watch.getSnapshot() };
}
const names = (rows: readonly { name: string; project: string }[] | undefined) =>
	rows?.map((r) => `${r.project}/${r.name}`);

describe("representations and scope", () => {
	it("identities only: URL list with all-projects=true", async () => {
		const list = mount(api.watchList(["name"], ALL_PROJECTS));
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances?all-projects=true"]);
		assert.deepEqual(names(list.get().data), ["default/db", "web/nginx", "default/old"]);
		assert.equal(list.get().complete, true);
	});

	it("selected fields use recursion=1; a project scope uses project=<name>", async () => {
		const list = mount(api.watchList(["status"], WEB));
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances?recursion=1&project=web"]);
		assert.deepEqual(list.get().data, [{ name: "nginx", project: "web", status: "Running" }]);
	});

	it("data only contains the selected fields (never config)", async () => {
		const list = mount(api.watchList(["description"], DEFAULT));
		await flush();
		for (const row of list.get().data ?? []) {
			assert.deepEqual(Object.keys(row).sort(), ["description", "name", "project"]);
		}
	});

	it("a status predicate with identities only is filtered on the server", async () => {
		const running = mount(api.watchList(["name"], ALL_PROJECTS, { status: "Running" }));
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances?all-projects=true&filter=status eq Running"]);
		assert.deepEqual(names(running.get().data), ["default/db", "web/nginx"]);
	});

	it("a complete broader result with known statuses answers narrower queries locally", async () => {
		mount(api.watchList(["status"], ALL_PROJECTS));
		await flush();
		incus.requests = [];
		const runningDefault = mount(api.watchList(["name"], DEFAULT, { status: "Running" }));
		const web = mount(api.watchList(["status"], WEB));
		const stopped = mount(api.watchList(["name"], ALL_PROJECTS, { status: "Stopped" }));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.deepEqual(names(runningDefault.get().data), ["default/db"]);
		assert.deepEqual(names(web.get().data), ["web/nginx"]);
		assert.deepEqual(names(stopped.get().data), ["default/old"]);
	});

	it("one instance: existence derived from membership, fields reused from the list", async () => {
		mount(api.watchList(["description"], DEFAULT));
		await flush();
		incus.requests = [];
		const db = mount(api.watch({ project: "default", name: "db" }, ["description"]));
		const gone = mount(api.watch({ project: "default", name: "nope" }, ["description"]));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.equal(db.get().data?.description, "database");
		assert.equal(gone.get().exists, false);
	});

	it("one instance in an unknown project uses its own endpoint with ?project=", async () => {
		const one = mount(api.watch({ project: "web", name: "nginx" }, ["status"]));
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances/nginx?project=web"]);
		assert.equal(one.get().data?.status, "Running");
	});

	it("a response is stored under the scope it was requested for", async () => {
		incus.hold();
		const a = mount(api.watchList(["name"], DEFAULT));
		await flush();
		const b = mount(api.watchList(["name"], WEB));
		incus.release();
		await flush();
		assert.deepEqual(names(a.get().data), ["default/db", "default/old"]);
		assert.deepEqual(names(b.get().data), ["web/nginx"]);
	});
});

describe("events mutate the store and keep queries reactive", () => {
	async function warm() {
		const all = mount(api.watchList(["status"], ALL_PROJECTS));
		const running = mount(api.watchList(["name"], ALL_PROJECTS, { status: "Running" }));
		const stopped = mount(api.watchList(["name"], ALL_PROJECTS, { status: "Stopped" }));
		await flush();
		incus.requests = [];
		return { all, running, stopped };
	}

	it("instance-started moves an instance between status queries with no request", async () => {
		const { all, running, stopped } = await warm();
		core.ingest(event("instance-started", "old"));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.deepEqual(names(running.get().data), ["default/db", "web/nginx", "default/old"]);
		assert.deepEqual(names(stopped.get().data), []);
		assert.equal(all.get().data?.find((r) => r.name === "old")?.status, "Running");
	});

	it("an initially empty query gains a member when an instance enters it", async () => {
		const frozen = mount(api.watchList(["name"], ALL_PROJECTS, { status: "Frozen" }));
		await warm();
		assert.deepEqual(frozen.get().data, []);
		core.ingest(event("instance-paused", "db"));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.deepEqual(names(frozen.get().data), ["default/db"]);
	});

	it("instance-created joins unfiltered lists at once; status lists resolve it with one GET", async () => {
		const { all, running, stopped } = await warm();
		incus.add("web", "new", "Stopped");
		core.ingest(event("instance-created", "new", "web"));
		assert.equal(running.get().complete, false, "membership is unresolved until its status is known");
		assert.deepEqual(names(running.get().data), ["default/db", "web/nginx"], "known members stay visible");
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances/new?project=web"]);
		assert.deepEqual(names(stopped.get().data), ["web/new", "default/old"]);
		assert.equal(running.get().complete, true);
		assert.equal(running.get().data?.some((r) => r.name === "new"), false);
		assert.equal(all.get().data?.find((r) => r.name === "new")?.status, "Stopped");
	});

	it("instance-deleted removes it everywhere with no request", async () => {
		const { all, running } = await warm();
		core.ingest(event("instance-deleted", "nginx", "web"));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.equal(all.get().data?.some((r) => r.name === "nginx"), false);
		assert.deepEqual(names(running.get().data), ["default/db"]);
		const gone = mount(api.watch({ project: "web", name: "nginx" }, ["name"]));
		await flush();
		assert.equal(gone.get().exists, false);
		assert.deepEqual(incus.requests, []);
	});

	it("instance-renamed moves the identity within its project and keeps fields", async () => {
		const { all, running } = await warm();
		core.ingest(event("instance-renamed", "database", "default", { old_name: "db" }));
		await flush();
		assert.deepEqual(incus.requests, []);
		assert.equal(all.get().data?.find((r) => r.name === "database")?.status, "Running");
		assert.equal(all.get().data?.some((r) => r.name === "db"), false);
		assert.deepEqual(names(running.get().data), ["default/database", "web/nginx"]);
	});

	it("instance-updated revalidates only that instance, only for ordinary-field consumers", async () => {
		const { all } = await warm();
		core.ingest(event("instance-updated", "db"));
		await flush();
		assert.deepEqual(incus.requests, [], "status consumers are unaffected by config updates");
		const described = mount(api.watchList(["description"], DEFAULT));
		await flush();
		incus.requests = [];
		incus.add("default", "db", "Running", "renamed db");
		core.ingest(event("instance-updated", "db"));
		await flush();
		assert.deepEqual(incus.requests, ["/1.0/instances/db?project=default"]);
		assert.equal(described.get().data?.find((r) => r.name === "db")?.description, "renamed db");
		assert.equal(all.get().fresh, true);
	});

	it("events in another project do not touch a project-scoped list", async () => {
		const def = mount(api.watchList(["name"], DEFAULT));
		await flush();
		incus.requests = [];
		core.ingest(event("instance-created", "x", "web"));
		await flush();
		assert.deepEqual(names(def.get().data), ["default/db", "default/old"]);
		assert.deepEqual(incus.requests, []);
	});

	it("sub-resource events (snapshots, files) are ignored", async () => {
		const { all } = await warm();
		const before = JSON.stringify(all.get());
		core.ingest({
			type: "lifecycle",
			timestamp: "t",
			metadata: { action: "instance-snapshot-created", source: "/1.0/instances/db/snapshots/s0" },
		});
		await flush();
		assert.equal(JSON.stringify(all.get()), before);
		assert.deepEqual(incus.requests, []);
	});

	it("a deletion during an in-flight list is not undone by the older response", async () => {
		incus.hold();
		const all = mount(api.watchList(["name"], ALL_PROJECTS));
		await flush();
		core.ingest(event("instance-deleted", "db"));
		incus.release();
		await flush();
		assert.equal(all.get().data?.some((r) => r.name === "db"), false);
	});

	it("interruption keeps data, restore reconciles with one list request", async () => {
		const { all } = await warm();
		core.setCoverage("interrupted");
		await flush();
		assert.equal(all.get().fresh, false);
		assert.deepEqual(incus.requests, []);
		core.setCoverage("connected");
		await flush();
		assert.ok((incus.requests as string[]).includes("/1.0/instances?recursion=1&all-projects=true"));
		assert.equal(all.get().fresh, true);
	});
});

describe("imperative consumers", () => {
	it("list() and get() share the store with hooks and type the selection", async () => {
		const running = await api.list(["status"], ALL_PROJECTS, { status: "Running" });
		assert.deepEqual(running.data?.map((r) => r.status), ["Running", "Running"]);
		const db = await api.get({ project: "default", name: "db" }, ["status"]);
		assert.equal(db.data?.status, "Running");
		assert.equal(incus.requests.length, 1);
		const idOnly = await api.list(["name"], DEFAULT);
		// @ts-expect-error status was not selected
		void idOnly.data?.[0]?.status;
	});
});
