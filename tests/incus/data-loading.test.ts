// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IncusApiError } from "../../src/lib/incus/client.ts";
import { collectionView, resourceView } from "../../src/lib/incus/data/loading.ts";

const error = new IncusApiError("network", "down");
const list = (over: Partial<Parameters<typeof collectionView>[0]>) =>
	collectionView({ data: undefined, missing: [], complete: false, error: null, ...over });

describe("collectionView", () => {
	it("shows a skeleton only while nothing is known", () => {
		assert.deepEqual(list({}), { kind: "skeleton" });
		// Membership known but incomplete and nothing to show yet.
		assert.deepEqual(list({ data: [] }), { kind: "skeleton" });
	});

	it("shows cached rows instead of a skeleton, even with a refresh error", () => {
		assert.deepEqual(list({ data: [{}], complete: true, error }), { kind: "data", pending: 0 });
	});

	it("reports members still loading alongside known rows", () => {
		assert.deepEqual(list({ data: [{}], missing: ["p/a", "p/b"], complete: true }), {
			kind: "data",
			pending: 2,
		});
		assert.deepEqual(list({ data: [], missing: ["p/a"], complete: true }), { kind: "data", pending: 1 });
	});

	it("distinguishes empty from failed", () => {
		assert.deepEqual(list({ data: [], complete: true }), { kind: "empty" });
		assert.deepEqual(list({ error }), { kind: "error", error });
	});
});

describe("resourceView", () => {
	it("covers data, absence, errors and loading", () => {
		assert.deepEqual(resourceView({ data: {}, exists: true, error }), { kind: "data" });
		assert.deepEqual(resourceView({ data: undefined, exists: false, error: null }), { kind: "absent" });
		assert.deepEqual(resourceView({ data: undefined, exists: undefined, error }), { kind: "error", error });
		assert.deepEqual(resourceView({ data: undefined, exists: undefined, error: null }), { kind: "skeleton" });
	});
});
