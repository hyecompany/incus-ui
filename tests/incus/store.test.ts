// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_PROJECTS } from "../../src/lib/incus/instances.ts";
import { planInstanceCollection } from "../../src/lib/incus/planner.ts";
import { createIncusStore } from "../../src/lib/incus/store.ts";

describe("incus observation store", () => {
	it("keeps same-named instances apart in an all-projects list", () => {
		const store = createIncusStore();
		store.applyCollection(store.beginReadAll(), {
			project: ALL_PROJECTS,
			status: null,
			representation: 1,
			entries: [
				{ name: "web-1", project: "default", status: "Running" },
				{ name: "web-1", project: "production", status: "Stopped" },
			],
		});
		const collection = store.getCollection(ALL_PROJECTS, null);
		assert.deepEqual(collection.names, ["default\0web-1", "production\0web-1"]);
		assert.equal(
			store.getInstance("default", "web-1")?.fields.status?.value,
			"Running",
		);
		assert.equal(
			store.getInstance("production", "web-1")?.fields.status?.value,
			"Stopped",
		);
		assert.equal(
			planInstanceCollection(store, ["name"], { allProjects: true }),
			null,
		);
	});

	it("keeps projects apart", () => {
		const store = createIncusStore("edge");
		const production = store.beginRead("production", []);
		assert.equal(
			store.applyCollection(production, {
				project: "production",
				status: null,
				representation: 0,
				entries: ["/1.0/instances/api?project=production"],
			}),
			true,
		);
		const defaults = store.beginRead("default", []);
		store.applyCollection(defaults, {
			project: "default",
			status: null,
			representation: 0,
			entries: ["/1.0/instances/web-1"],
		});

		assert.deepEqual(store.getCollection("production", null).names, ["api"]);
		assert.deepEqual(store.getCollection("default", null).names, ["web-1"]);
		assert.equal(store.getInstance("default", "api"), undefined);
		assert.equal(store.getInstance("production", "web-1"), undefined);
		assert.equal(
			store.getInstance("production", "api")?.fields.project?.value,
			"production",
		);
		assert.equal(store.getInstance("production", "api")?.deploymentId, "edge");
	});

	it("learns membership and identity from urls without inventing status", () => {
		const store = createIncusStore();
		let notifications = 0;
		const unsubscribe = store.subscribe(() => {
			notifications += 1;
		});
		const version = store.version();
		const token = store.beginRead("default", []);
		store.applyCollection(token, {
			project: "default",
			status: null,
			representation: 0,
			entries: ["/1.0/instances/web-1", "/1.0/instances/db-1"],
		});
		unsubscribe();

		assert.equal(notifications, 1);
		assert.equal(store.version(), version + 1);
		const collection = store.getCollection("default", null);
		assert.deepEqual(collection.names, ["web-1", "db-1"]);
		assert.equal(collection.complete, true);
		assert.equal(collection.fresh, true);
		const web = store.getInstance("default", "web-1");
		assert.equal(web?.fields.name?.value, "web-1");
		assert.equal(web?.fields.name?.fresh, true);
		assert.equal(web?.fields.project?.value, "default");
		assert.equal(web?.fields.status, undefined);
		assert.equal(web?.fields.statusCode, undefined);
	});

	it("fills status from objects and keeps a description the object omits", () => {
		const store = createIncusStore();
		const created = store.beginRead("default", ["web-1"]);
		assert.equal(
			store.applyInstanceFields(created, "default", {
				name: "web-1",
				description: "keep me",
				status: "Stopped",
			}),
			true,
		);
		const token = store.beginRead("default", ["web-1"]);
		store.applyCollection(token, {
			project: "default",
			status: null,
			representation: 1,
			entries: [
				{
					name: "web-1",
					status: "Running",
					status_code: 103,
					location: "none",
					config: { "user.secret": "do-not-keep" },
					devices: { eth0: { type: "nic" } },
				},
			],
		});

		const web = store.getInstance("default", "web-1");
		assert.equal(web?.fields.status?.value, "Running");
		assert.equal(web?.fields.statusCode?.value, 103);
		assert.equal(web?.fields.description?.value, "keep me");
		assert.equal(web?.fields.description?.fresh, true);
		const encoded = JSON.stringify(web);
		assert.equal(encoded.includes("do-not-keep"), false);
		assert.equal(encoded.includes("config"), false);
		assert.equal(encoded.includes("devices"), false);
		assert.equal("config" in (web?.fields ?? {}), false);
	});

	it("treats an empty collection as a complete empty result", () => {
		const store = createIncusStore();
		const token = store.beginRead("default", []);
		store.applyCollection(token, {
			project: "default",
			status: null,
			representation: 0,
			entries: [],
		});
		const collection = store.getCollection("default", null);
		assert.deepEqual(collection.names, []);
		assert.equal(collection.complete, true);
		assert.equal(collection.fresh, true);
		assert.equal(collection.fetching, false);
		assert.equal(collection.error, null);
	});

	it("does not apply a pre-delete token onto the recreated lifecycle", () => {
		const store = createIncusStore();
		const created = store.beginRead("default", ["web-1"]);
		store.applyInstanceFields(created, "default", {
			name: "web-1",
			status: "Running",
			description: "old",
		});
		store.applyCollection(store.beginRead("default", ["web-1"]), {
			project: "default",
			status: null,
			representation: 0,
			entries: ["/1.0/instances/web-1"],
		});
		const stale = store.beginRead("default", ["web-1"]);
		store.deleteInstance("default", "web-1");
		assert.deepEqual(store.getCollection("default", null).names, []);
		assert.equal(
			store.getInstance("default", "web-1")?.fields.status,
			undefined,
		);
		store.noteCreated("default", "web-1");

		assert.equal(
			store.applyInstanceFields(stale, "default", {
				name: "web-1",
				status: "Running",
				description: "old",
			}),
			false,
		);
		const recreated = store.getInstance("default", "web-1");
		assert.equal(recreated?.fields.name?.value, "web-1");
		assert.equal(recreated?.fields.project?.value, "default");
		assert.equal(recreated?.fields.status, undefined);
		assert.equal(recreated?.fields.description, undefined);
		assert.ok((recreated?.lifecycle ?? 0) > 1);

		const current = store.beginRead("default", ["web-1"]);
		assert.equal(
			store.applyInstanceFields(current, "default", {
				name: "web-1",
				status: "Stopped",
			}),
			true,
		);
		assert.equal(
			store.getInstance("default", "web-1")?.fields.status?.value,
			"Stopped",
		);
	});

	it("rejects an older token after the session is replaced", () => {
		const store = createIncusStore();
		store.noteCreated("default", "web-1");
		const token = store.beginRead("default", ["web-1"]);
		store.bumpSession();
		const version = store.version();

		assert.equal(store.getInstance("default", "web-1"), undefined);
		assert.equal(store.getCollection("default", null).complete, false);
		assert.equal(
			store.applyInstanceFields(token, "default", {
				name: "web-1",
				status: "Running",
			}),
			false,
		);
		assert.equal(
			store.applyCollection(token, {
				project: "default",
				status: null,
				representation: 0,
				entries: ["/1.0/instances/web-1"],
			}),
			false,
		);
		assert.equal(store.getInstance("default", "web-1"), undefined);
		assert.equal(store.version(), version);
	});

	it("leaves names in place when observations are marked stale", () => {
		const store = createIncusStore();
		store.applyCollection(store.beginRead("default", []), {
			project: "default",
			status: null,
			representation: 1,
			entries: [
				{
					name: "web-1",
					status: "Running",
					location: "none",
					project: "default",
				},
			],
		});
		assert.equal(planInstanceCollection(store, ["name", "location"], {}), null);
		store.invalidateAll();

		const web = store.getInstance("default", "web-1");
		assert.equal(web?.fields.name?.value, "web-1");
		assert.equal(web?.fields.name?.fresh, false);
		assert.equal(web?.fields.location?.value, "none");
		assert.equal(web?.fields.location?.fresh, false);
		const collection = store.getCollection("default", null);
		assert.deepEqual(collection.names, ["web-1"]);
		assert.equal(collection.complete, true);
		assert.equal(collection.fresh, false);

		const plan = planInstanceCollection(store, ["name", "location"], {});
		assert.ok(plan);
		assert.equal(plan.representation, 1);
		assert.equal(plan.project, "default");
		assert.equal(plan.reason, "stale");
		const url = new URL(plan.path, "https://incus.local");
		assert.equal(url.pathname, "/1.0/instances");
		assert.equal(url.searchParams.get("recursion"), "1");
		assert.equal(url.searchParams.get("project"), null);
	});

	it("shares one inflight execution and starts over after it settles", async () => {
		const store = createIncusStore();
		let runs = 0;
		let release: (value: string) => void = () => {};
		const first = store.inflight(
			"instances",
			() =>
				new Promise<string>((resolve) => {
					runs += 1;
					release = resolve;
				}),
		);
		const second = store.inflight("instances", () => {
			runs += 1;
			return Promise.resolve("other");
		});
		assert.equal(runs, 1);
		release("shared");
		assert.equal(await first, "shared");
		assert.equal(await second, "shared");

		const third = store.inflight("instances", () => {
			runs += 1;
			return Promise.resolve("next");
		});
		assert.equal(await third, "next");
		assert.equal(runs, 2);

		const rejected = store.inflight("instances", () =>
			Promise.reject(new Error("down")),
		);
		const waiting = store.inflight("instances", () => Promise.resolve("later"));
		await assert.rejects(rejected, { message: "down" });
		await assert.rejects(waiting, { message: "down" });
		assert.equal(runs, 2);
		const again = store.inflight("instances", () => {
			runs += 1;
			return Promise.resolve("after");
		});
		assert.equal(await again, "after");
		assert.equal(runs, 3);
	});

	it("keeps a newer instance in membership without restoring the stale record", () => {
		const store = createIncusStore();
		store.noteCreated("default", "web-1");
		const stale = store.beginRead("default", []);
		store.deleteInstance("default", "web-1");
		store.noteCreated("default", "web-1");
		store.applyCollection(stale, {
			project: "default",
			status: null,
			representation: 1,
			entries: [
				{
					name: "web-1",
					status: "Running",
					description: "old",
					project: "default",
				},
			],
		});
		const collection = store.getCollection("default", null);
		assert.deepEqual(collection.names, ["web-1"]);
		assert.equal(
			store.getInstance("default", "web-1")?.fields.status,
			undefined,
		);
		assert.equal(
			store.getInstance("default", "web-1")?.fields.description,
			undefined,
		);
	});

	it("keeps names when a collection is fetching or failed", () => {
		const store = createIncusStore();
		store.applyCollection(store.beginRead("default", []), {
			project: "default",
			status: null,
			representation: 0,
			entries: ["/1.0/instances/web-1"],
		});
		store.markCollectionFetching("default", null, true);
		const fetching = store.getCollection("default", null);
		assert.deepEqual(fetching.names, ["web-1"]);
		assert.equal(fetching.fetching, true);
		assert.equal(fetching.complete, true);
		assert.equal(fetching.fresh, true);

		store.setCollectionError("default", null, {
			message: "not authorized",
			status: 403,
		});
		const failed = store.getCollection("default", null);
		assert.deepEqual(failed.names, ["web-1"]);
		assert.equal(failed.fresh, false);
		assert.equal(failed.complete, true);
		assert.deepEqual(failed.error, { message: "not authorized", status: 403 });
		assert.equal(failed.fetching, true);
	});
});

describe("instance collection planner", () => {
	it("answers a status filter from a fresh unfiltered collection", () => {
		const store = createIncusStore();
		store.applyCollection(store.beginRead("default", []), {
			project: "default",
			status: null,
			representation: 1,
			entries: [
				{ name: "web-1", status: "Running", project: "default" },
				{ name: "db-1", status: "Stopped", project: "default" },
				{ name: "batch-1", status: "running", project: "default" },
			],
		});

		assert.equal(
			planInstanceCollection(store, ["name", "status"], { status: "Running" }),
			null,
		);
		const running = store.getCollection("default", "Running");
		assert.deepEqual(running.names, ["web-1", "batch-1"]);
		assert.equal(running.complete, true);
		assert.equal(running.fresh, true);
		assert.equal(running.fetching, false);
		assert.equal(running.error, null);
		assert.deepEqual(store.getCollection("default", null).names, [
			"web-1",
			"db-1",
			"batch-1",
		]);
	});

	it("sends a pattern-like status to the server", () => {
		const store = createIncusStore();
		store.applyCollection(store.beginRead("default", []), {
			project: "default",
			status: null,
			representation: 1,
			entries: [
				{ name: "web-1", status: "Running", project: "default" },
				{ name: "batch-1", status: "running", project: "default" },
			],
		});

		const plan = planInstanceCollection(store, ["name"], { status: "run.*" });
		assert.ok(plan);
		assert.equal(plan.representation, 0);
		assert.equal(plan.project, "default");
		assert.equal(plan.reason, "incomplete");
		const url = new URL(plan.path, "https://incus.local");
		assert.equal(url.searchParams.get("filter"), "status eq run.*");
		assert.equal(url.searchParams.get("recursion"), null);
		assert.equal(url.searchParams.get("project"), null);
		assert.equal(store.getCollection("default", "run.*").complete, false);
		assert.deepEqual(store.getCollection("default", "run.*").names, []);
	});

	it("does not treat a name list as enough when location is required", () => {
		const store = createIncusStore();
		store.applyCollection(store.beginRead("default", []), {
			project: "default",
			status: null,
			representation: 0,
			entries: ["/1.0/instances/web-1"],
		});

		assert.equal(planInstanceCollection(store, ["name"], {}), null);
		const plan = planInstanceCollection(store, ["location"], {});
		assert.ok(plan);
		assert.equal(plan.representation, 1);
		assert.equal(plan.reason, "fields");
		const url = new URL(plan.path, "https://incus.local");
		assert.equal(url.searchParams.get("recursion"), "1");
		assert.equal(url.searchParams.get("filter"), null);
		assert.notEqual(url.searchParams.get("recursion"), "2");
	});
});
