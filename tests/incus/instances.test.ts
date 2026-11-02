// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IncusApiError } from "../../src/lib/incus/client.ts";
import {
	instanceFilter,
	instanceIdentityFromUrl,
	matchesCriteria,
	parseInstanceObject,
} from "../../src/lib/incus/instances.ts";
import { ALL_PROJECTS } from "../../src/lib/incus/project-scope.ts";

const isMalformed = (e: unknown) => e instanceof IncusApiError && e.kind === "malformed";

describe("instance identities from URLs", () => {
	it("uses ?project= when Incus adds it, else the requested project, else default", () => {
		assert.deepEqual(instanceIdentityFromUrl("/1.0/instances/a?project=web", ALL_PROJECTS), { project: "web", name: "a" });
		assert.deepEqual(instanceIdentityFromUrl("/1.0/instances/a", ALL_PROJECTS), { project: "default", name: "a" });
		assert.deepEqual(instanceIdentityFromUrl("/1.0/instances/a", { kind: "project", name: "web" }), { project: "web", name: "a" });
		assert.deepEqual(instanceIdentityFromUrl("/1.0/instances/a%20b", ALL_PROJECTS), { project: "default", name: "a b" });
		assert.throws(() => instanceIdentityFromUrl("/1.0/projects/a", ALL_PROJECTS), isMalformed);
	});
});

describe("criteria", () => {
	it("builds the server filter and evaluates it locally with the same (case-insensitive) semantics", () => {
		assert.equal(instanceFilter({ status: "Running" }), "status eq Running");
		assert.equal(instanceFilter({}), undefined);
		assert.equal(matchesCriteria("running", { status: "Running" }), true);
		assert.equal(matchesCriteria("Stopped", { status: "Running" }), false);
		assert.equal(matchesCriteria(undefined, { status: "Running" }), undefined, "unknown status is not guessed");
		assert.equal(matchesCriteria(undefined, {}), true);
	});
});

describe("parsing", () => {
	it("keeps ordinary fields with config and devices, and no runtime state", () => {
		const parsed = parseInstanceObject(
			{ name: "a", project: "web", status: "Running", status_code: 103, config: { x: "y" }, devices: {}, profiles: ["default"] },
			"x",
		);
		assert.equal(parsed.project, "web");
		assert.equal(parsed.statusCode, 103);
		assert.deepEqual(parsed.config, { x: "y" });
		assert.deepEqual(parsed.devices, {});
		assert.equal("pid" in parsed, false);
		assert.throws(() => parseInstanceObject({ name: "a", config: { x: 1 } }, "x"), isMalformed);
		assert.throws(() => parseInstanceObject({ status: "Running" }, "x"), isMalformed);
		assert.throws(() => parseInstanceObject({ name: "a", status_code: "103" }, "x"), isMalformed);
		assert.throws(() => parseInstanceObject({ name: "a", profiles: [1] }, "x"), isMalformed);
	});
});
