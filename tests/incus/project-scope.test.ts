// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIncusUrl } from "../../src/lib/incus/client.ts";
import {
	ALL_PROJECTS,
	createProjectScopeStore,
	isSameScope,
	type ProjectScope,
	projectScopeKey,
	projectScopeQuery,
	scopeFromKey,
} from "../../src/lib/incus/project-scope.ts";

const DEFAULT_PROJECT: ProjectScope = { kind: "project", name: "default" };
const DEV_PROJECT: ProjectScope = { kind: "project", name: "dev" };
const BOTH = { allProjects: true, project: true };
const NONE = { allProjects: false, project: false };

describe("default selection", () => {
	it("starts in All Projects mode", () => {
		const store = createProjectScopeStore();
		assert.deepEqual(store.get(), { kind: "all" });
		assert.equal(store.get(), ALL_PROJECTS);
	});

	it("honours an explicit initial scope", () => {
		const store = createProjectScopeStore(DEV_PROJECT);
		assert.deepEqual(store.get(), DEV_PROJECT);
	});
});

describe("all vs default distinction", () => {
	it("keys All Projects and the Incus default project differently", () => {
		assert.notEqual(projectScopeKey(ALL_PROJECTS), projectScopeKey(DEFAULT_PROJECT));
		assert.equal(projectScopeKey(ALL_PROJECTS), "all");
		assert.equal(projectScopeKey(DEFAULT_PROJECT), "project:default");
	});

	it("treats a project literally named 'all' as distinct from All Projects", () => {
		const named: ProjectScope = { kind: "project", name: "all" };
		assert.notEqual(projectScopeKey(named), projectScopeKey(ALL_PROJECTS));
		assert.equal(isSameScope(named, ALL_PROJECTS), false);
	});

	it("does not send the default project as all-projects", () => {
		assert.deepEqual(projectScopeQuery(DEFAULT_PROJECT, BOTH), { project: "default" });
		assert.deepEqual(projectScopeQuery(ALL_PROJECTS, BOTH), { "all-projects": "true" });
	});

	it("round-trips keys through scopeFromKey", () => {
		for (const scope of [ALL_PROJECTS, DEFAULT_PROJECT, DEV_PROJECT]) {
			assert.deepEqual(scopeFromKey(projectScopeKey(scope)), scope);
		}
		assert.equal(scopeFromKey("project:"), null);
		assert.equal(scopeFromKey("bogus"), null);
	});
});

describe("switching and subscriptions", () => {
	it("updates the value and notifies subscribers on change", () => {
		const store = createProjectScopeStore();
		let calls = 0;
		store.subscribe(() => {
			calls += 1;
		});

		store.set(DEFAULT_PROJECT);
		assert.deepEqual(store.get(), DEFAULT_PROJECT);
		assert.equal(calls, 1);

		store.set(ALL_PROJECTS);
		assert.deepEqual(store.get(), ALL_PROJECTS);
		assert.equal(calls, 2);
	});

	it("does not notify when the scope is set to an equal value", () => {
		const store = createProjectScopeStore(DEV_PROJECT);
		let calls = 0;
		store.subscribe(() => {
			calls += 1;
		});

		store.set({ kind: "project", name: "dev" });
		store.set(DEV_PROJECT);
		assert.equal(calls, 0);
	});

	it("stops notifying after unsubscribe", () => {
		const store = createProjectScopeStore();
		let calls = 0;
		const unsubscribe = store.subscribe(() => {
			calls += 1;
		});

		store.set(DEV_PROJECT);
		unsubscribe();
		store.set(ALL_PROJECTS);
		assert.equal(calls, 1);
	});

	it("notifies every subscriber", () => {
		const store = createProjectScopeStore();
		const seen: string[] = [];
		store.subscribe(() => seen.push("a"));
		store.subscribe(() => seen.push("b"));

		store.set(DEV_PROJECT);
		assert.deepEqual(seen, ["a", "b"]);
	});
});

describe("projectScopeQuery", () => {
	it("attaches all-projects only for all scope when supported", () => {
		assert.deepEqual(projectScopeQuery(ALL_PROJECTS, { allProjects: true, project: false }), {
			"all-projects": "true",
		});
	});

	it("attaches project only for project scope when supported", () => {
		assert.deepEqual(projectScopeQuery(DEV_PROJECT, { allProjects: false, project: true }), {
			project: "dev",
		});
	});

	it("never attaches parameters an endpoint does not declare", () => {
		assert.deepEqual(projectScopeQuery(ALL_PROJECTS, NONE), {});
		assert.deepEqual(projectScopeQuery(DEV_PROJECT, NONE), {});
		assert.deepEqual(projectScopeQuery(ALL_PROJECTS, { allProjects: false, project: true }), {});
		assert.deepEqual(projectScopeQuery(DEV_PROJECT, { allProjects: true, project: false }), {});
	});

	it("composes with buildIncusUrl and preserves existing parameters", () => {
		const url = buildIncusUrl(
			"/1.0/instances?recursion=1&filter=name%20eq%20web",
			projectScopeQuery(ALL_PROJECTS, { allProjects: true, project: false }),
		);
		const parsed = new URL(url, "https://example.invalid");
		assert.equal(parsed.pathname, "/1.0/instances");
		assert.equal(parsed.searchParams.get("recursion"), "1");
		assert.equal(parsed.searchParams.get("filter"), "name eq web");
		assert.equal(parsed.searchParams.get("all-projects"), "true");
	});

	it("preserves existing parameters when a project is attached", () => {
		const url = buildIncusUrl(
			"/1.0/instances?recursion=1",
			projectScopeQuery(DEV_PROJECT, BOTH),
		);
		const parsed = new URL(url, "https://example.invalid");
		assert.equal(parsed.searchParams.get("recursion"), "1");
		assert.equal(parsed.searchParams.get("project"), "dev");
		assert.equal(parsed.searchParams.get("all-projects"), null);
	});
});
