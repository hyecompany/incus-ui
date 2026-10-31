// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	latestApiSample,
	resetApiTimingsForTests,
} from "../../src/lib/incus/timings.ts";
import { incusRequest } from "../../src/lib/incus/transport.ts";

function syncResponse(metadata: unknown, status = 200): Response {
	return new Response(
		JSON.stringify({
			type: "sync",
			status: "Success",
			status_code: status,
			operation: "",
			error: "",
			error_code: 0,
			metadata,
		}),
		{ status },
	);
}

describe("api timings", () => {
	it("records how long an instances response took", async () => {
		resetApiTimingsForTests();
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return syncResponse([]);
		};
		try {
			await incusRequest("/1.0/instances?recursion=1&all-projects=true");
			const sample = latestApiSample("/1.0/instances");
			assert.ok(sample);
			assert.equal(sample.ok, true);
			assert.equal(sample.status, 200);
			assert.equal(sample.method, "GET");
			assert.equal(sample.path, "/1.0/instances?recursion=1&all-projects=true");
			assert.ok(sample.durationMs >= 25);
			assert.ok(sample.bytes > 0);
		} finally {
			globalThis.fetch = previous;
			resetApiTimingsForTests();
		}
	});

	it("records a failed response as well", async () => {
		resetApiTimingsForTests();
		const previous = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					type: "error",
					error: "not authorized",
					error_code: 403,
					status: "",
					status_code: 0,
					operation: "",
					metadata: null,
				}),
				{ status: 403 },
			);
		try {
			await assert.rejects(() => incusRequest("/1.0/instances"));
			const sample = latestApiSample("/1.0/instances");
			assert.ok(sample);
			assert.equal(sample.ok, false);
			assert.equal(sample.status, 403);
		} finally {
			globalThis.fetch = previous;
			resetApiTimingsForTests();
		}
	});
});
