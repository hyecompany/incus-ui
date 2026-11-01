// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	READ_POLICY,
	withRetry,
} from "../../src/lib/incus/internal/request.ts";
import { readNumber, readString } from "../../src/lib/incus/internal/values.ts";
import { IncusRequestError } from "../../src/lib/incus/transport.ts";

describe("incus internal helpers", () => {
	it("readString and readNumber return undefined for null, an array, and an object missing the key", () => {
		for (const source of [null, ["name"], { other: "value" }]) {
			assert.equal(readString(source, "name"), undefined);
			assert.equal(readNumber(source, "status_code"), undefined);
		}
	});

	it("withRetry retries a 503 exactly 3 times, and a sleep stub sees 150 then 400", async () => {
		const sleeps: number[] = [];
		let calls = 0;
		const error = new IncusRequestError("unavailable", 503, 503);
		await assert.rejects(
			() =>
				withRetry(
					async () => {
						calls += 1;
						throw error;
					},
					READ_POLICY,
					async (ms) => {
						sleeps.push(ms);
					},
				),
			(caught: unknown) => caught === error,
		);
		assert.equal(calls, 3);
		assert.deepEqual(sleeps, [150, 400]);
	});

	it("withRetry calls a 403 once and rethrows it", async () => {
		let calls = 0;
		const error = new IncusRequestError("forbidden", 403, 403);
		await assert.rejects(
			() =>
				withRetry(async () => {
					calls += 1;
					throw error;
				}, READ_POLICY),
			(caught: unknown) => caught === error,
		);
		assert.equal(calls, 1);
	});
});
