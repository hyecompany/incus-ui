// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffDelay, DEFAULT_BACKOFF } from "../../src/lib/incus/events/backoff.ts";
import { parseEventFrame } from "../../src/lib/incus/events/parse.ts";

const LIFECYCLE = {
	type: "lifecycle",
	timestamp: "2026-11-01T10:00:00Z",
	metadata: { action: "instance-started", source: "/1.0/instances/a" },
};

describe("parseEventFrame", () => {
	it("accepts a JSON string frame and copies only the required fields", () => {
		const result = parseEventFrame(JSON.stringify(LIFECYCLE));
		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.deepEqual(result.event, LIFECYCLE);
		assert.equal("project" in result.event, false);
		assert.equal("location" in result.event, false);
	});

	it("preserves project and location when Incus sends them", () => {
		const result = parseEventFrame({
			...LIFECYCLE,
			project: "dev",
			location: "node-2",
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.event.project, "dev");
			assert.equal(result.event.location, "node-2");
		}
	});

	it("never guesses project from metadata.source", () => {
		const result = parseEventFrame(LIFECYCLE);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.event.project, undefined);
		}
	});

	it("rejects unknown event types and malformed envelopes with a fixed reason", () => {
		assert.deepEqual(parseEventFrame({ ...LIFECYCLE, type: "bogus" }), {
			ok: false,
			reason: "type",
		});
		assert.deepEqual(parseEventFrame({ ...LIFECYCLE, timestamp: 1 }), {
			ok: false,
			reason: "timestamp",
		});
		assert.deepEqual(parseEventFrame({ type: "lifecycle", timestamp: "t" }), {
			ok: false,
			reason: "metadata",
		});
		assert.deepEqual(parseEventFrame([LIFECYCLE]), {
			ok: false,
			reason: "not-object",
		});
		assert.deepEqual(parseEventFrame("{not json"), {
			ok: false,
			reason: "not-json",
		});
	});

	it("rejects a non-string project or location instead of copying it", () => {
		assert.deepEqual(parseEventFrame({ ...LIFECYCLE, project: 7 }), {
			ok: false,
			reason: "project",
		});
		assert.deepEqual(parseEventFrame({ ...LIFECYCLE, location: null }), {
			ok: false,
			reason: "location",
		});
	});

	it("never echoes the payload in the failure reason", () => {
		const secret = "super-secret-token-value";
		const result = parseEventFrame({ ...LIFECYCLE, type: secret });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason.includes(secret), false);
		}
	});
});

describe("backoffDelay", () => {
	it("grows exponentially and applies full jitter", () => {
		assert.equal(backoffDelay(0, () => 0.5), 500);
		assert.equal(backoffDelay(1, () => 0.5), 1000);
		assert.equal(backoffDelay(2, () => 0.5), 2000);
		assert.equal(backoffDelay(3, () => 0), 0);
	});

	it("caps at maxMs for large attempts", () => {
		for (const attempt of [5, 10, 50, 10_000]) {
			const delay = backoffDelay(attempt, () => 0.999999);
			assert.ok(delay <= DEFAULT_BACKOFF.maxMs, `attempt ${attempt}: ${delay}`);
		}
		assert.equal(backoffDelay(20, () => 1), DEFAULT_BACKOFF.maxMs);
	});

	it("clamps a misbehaving random source into [0, ceiling]", () => {
		assert.equal(backoffDelay(0, () => 5), 1000);
		assert.equal(backoffDelay(0, () => -5), 0);
	});
});
