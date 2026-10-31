// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	instanceCollectionRequest,
	instanceFromObject,
	instanceIdentityFromUrl,
	pickInstance,
} from "../../src/lib/incus/instances.ts";
import { toDataResult } from "../../src/lib/incus/result.ts";
import {
	IncusRequestError,
	incusRequest,
} from "../../src/lib/incus/transport.ts";

describe("instance requests", () => {
	it("asks for urls when only names are needed", () => {
		const request = instanceCollectionRequest(["name"], { status: "Running" });
		const url = new URL(request.path, "https://incus.local");
		assert.equal(url.pathname, "/1.0/instances");
		assert.equal(url.searchParams.get("recursion"), null);
		assert.equal(url.searchParams.get("filter"), "status eq Running");
		assert.equal(url.searchParams.get("project"), null);
		assert.equal(request.project, "default");
		assert.equal(request.representation, 0);
	});

	it("asks every project when the selector is in all-projects mode", () => {
		const request = instanceCollectionRequest(["name"], { allProjects: true });
		const url = new URL(request.path, "https://incus.local");
		assert.equal(url.searchParams.get("all-projects"), "true");
		assert.equal(url.searchParams.get("project"), null);
		assert.equal(url.searchParams.get("recursion"), null);
	});

	it("keeps an explicit project ahead of all-projects mode", () => {
		const request = instanceCollectionRequest(["name"], {
			allProjects: true,
			project: "production",
		});
		const url = new URL(request.path, "https://incus.local");
		assert.equal(url.searchParams.get("project"), "production");
		assert.equal(url.searchParams.get("all-projects"), null);
	});

	it("asks for objects when ordinary fields are needed and keeps the project on the request", () => {
		const request = instanceCollectionRequest(["name", "location"], {
			project: "production",
			status: "Running",
		});
		const url = new URL(request.path, "https://incus.local");
		assert.equal(url.searchParams.get("recursion"), "1");
		assert.equal(url.searchParams.get("project"), "production");
		assert.equal(request.project, "production");
		assert.equal(request.representation, 1);
	});

	it("reads a name from a collection url without treating that url as the project", () => {
		assert.deepEqual(instanceIdentityFromUrl("/1.0/instances/web-1"), {
			name: "web-1",
			project: "default",
		});
		assert.deepEqual(
			instanceIdentityFromUrl("/1.0/instances/web-1?project=production"),
			{ name: "web-1", project: "production" },
		);
	});

	it("copies only the instance fields the data layer understands", () => {
		const instance = instanceFromObject({
			name: "web-1",
			status: "Running",
			status_code: 103,
			location: "none",
			type: "container",
			project: "default",
			config: { "user.secret": "do-not-keep" },
		});
		assert.equal(instance.name, "web-1");
		assert.equal(instance.statusCode, 103);
		assert.equal("config" in instance, false);
		assert.deepEqual(pickInstance(instance, ["name", "status"]), {
			name: "web-1",
			status: "Running",
		});
	});
});

describe("incus responses", () => {
	it("returns sync metadata and the etag", async () => {
		const previous = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					type: "sync",
					status: "Success",
					status_code: 200,
					operation: "",
					error: "",
					error_code: 0,
					metadata: ["/1.0/instances/web-1"],
				}),
				{ status: 200, headers: { etag: '"abc"' } },
			);
		try {
			const result = await incusRequest<string[]>("/1.0/instances");
			assert.deepEqual(result.metadata, ["/1.0/instances/web-1"]);
			assert.equal(result.etag, '"abc"');
			assert.equal(result.type, "sync");
		} finally {
			globalThis.fetch = previous;
		}
	});

	it("surfaces the Incus error instead of an empty payload", async () => {
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
			await assert.rejects(
				() => incusRequest("/1.0/instances"),
				(error: unknown) => {
					assert.ok(error instanceof IncusRequestError);
					assert.equal(error.message, "not authorized");
					assert.equal(error.status, 403);
					assert.equal(error.errorCode, 403);
					return true;
				},
			);
		} finally {
			globalThis.fetch = previous;
		}
	});
});

describe("data results", () => {
	it("keeps the last instances visible when a refresh fails", () => {
		const error = new IncusRequestError("not authorized", 403, 403);
		const result = toDataResult({
			data: [{ name: "web-1" }],
			error,
			isFetching: false,
			isSuccess: false,
			isPlaceholderData: false,
		});
		assert.deepEqual(result.data, [{ name: "web-1" }]);
		assert.equal(result.available, true);
		assert.equal(result.complete, false);
		assert.equal(result.fresh, false);
		assert.equal(result.error, error);
	});
});
