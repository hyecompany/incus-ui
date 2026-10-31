// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	projectScope,
	projectScopeVersion,
	resetProjectScopeForTests,
	setProjectScope,
	subscribeProjectScope,
} from "../../src/lib/incus/project-scope.ts";

describe("project scope", () => {
	it("default is all", () => {
		resetProjectScopeForTests();
		assert.deepEqual(projectScope(), { kind: "all" });
		assert.equal(projectScopeVersion(), 0);
	});

	it("switch to production notifies once and projectScope() matches", () => {
		resetProjectScopeForTests();
		let notifications = 0;
		const unsubscribe = subscribeProjectScope(() => {
			notifications += 1;
		});
		const before = projectScopeVersion();
		setProjectScope({ kind: "project", name: "production" });
		unsubscribe();

		assert.equal(notifications, 1);
		assert.equal(projectScopeVersion(), before + 1);
		assert.deepEqual(projectScope(), {
			kind: "project",
			name: "production",
		});
	});

	it("setting production again does not notify", () => {
		resetProjectScopeForTests();
		setProjectScope({ kind: "project", name: "production" });
		let notifications = 0;
		const unsubscribe = subscribeProjectScope(() => {
			notifications += 1;
		});
		const before = projectScopeVersion();
		setProjectScope({ kind: "project", name: "production" });
		unsubscribe();

		assert.equal(notifications, 0);
		assert.equal(projectScopeVersion(), before);
	});

	it("blank project name becomes all", () => {
		resetProjectScopeForTests();
		setProjectScope({ kind: "project", name: "staging" });
		setProjectScope({ kind: "project", name: "   " });
		assert.deepEqual(projectScope(), { kind: "all" });
	});

	it("reset returns to all", () => {
		resetProjectScopeForTests();
		setProjectScope({ kind: "project", name: "production" });
		resetProjectScopeForTests();
		assert.deepEqual(projectScope(), { kind: "all" });
		assert.equal(projectScopeVersion(), 0);
	});
});
