// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ensureProject,
	ensureProjects,
	projectCollectionRequest,
	projectFromObject,
	projectIdentityFromUrl,
	readProject,
	readProjects,
	resetProjectsForTests,
} from "../../src/lib/incus/projects.ts";
import { incusRequest } from "../../src/lib/incus/transport.ts";

describe("project requests", () => {
	it("names-only request omits recursion and parses URL names", () => {
		const request = projectCollectionRequest(["name"]);
		const url = new URL(request.path, "https://incus.local");
		assert.equal(url.pathname, "/1.0/projects");
		assert.equal(url.searchParams.get("recursion"), null);
		assert.equal(request.representation, 0);
		assert.deepEqual(
			projectIdentityFromUrl("/1.0/projects/production?ignored=1"),
			{ name: "production" },
		);
	});

	it("description request uses recursion=1", () => {
		const request = projectCollectionRequest(["name", "description"]);
		const url = new URL(request.path, "https://incus.local");
		assert.equal(url.searchParams.get("recursion"), "1");
		assert.equal(request.representation, 1);
	});

	it("config.user.secret is dropped", () => {
		const project = projectFromObject({
			name: "default",
			description: "Primary",
			config: { "user.secret": "do-not-keep" },
			used_by: ["/1.0/instances/web-1"],
		});
		assert.equal(project.name, "default");
		assert.equal(project.description, "Primary");
		assert.equal("config" in project, false);
		assert.equal("used_by" in project, false);
	});
});

describe("project cache", () => {
	it("description already known survives a later name-only refresh", async () => {
		resetProjectsForTests();
		let call = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async (input) => {
			call += 1;
			const url = String(input);
			if (call === 1) {
				assert.match(url, /recursion=1/);
				return new Response(
					JSON.stringify({
						type: "sync",
						status: "Success",
						status_code: 200,
						operation: "",
						error: "",
						error_code: 0,
						metadata: [
							{
								name: "default",
								description: "Primary",
								config: {},
								used_by: [],
							},
						],
					}),
					{ status: 200 },
				);
			}
			assert.doesNotMatch(url, /recursion=1/);
			return new Response(
				JSON.stringify({
					type: "sync",
					status: "Success",
					status_code: 200,
					operation: "",
					error: "",
					error_code: 0,
					metadata: ["/1.0/projects/default"],
				}),
				{ status: 200 },
			);
		};
		try {
			await ensureProjects(["description"]);
			await ensureProjects(["name"]);
			const result = readProjects(["name", "description"]);
			assert.deepEqual(result.data, [
				{ name: "default", description: "Primary" },
			]);
			assert.equal(result.complete, true);
		} finally {
			globalThis.fetch = previous;
			resetProjectsForTests();
		}
	});

	it("two concurrent ensureProjects share one fetch", async () => {
		resetProjectsForTests();
		let calls = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 20));
			return new Response(
				JSON.stringify({
					type: "sync",
					status: "Success",
					status_code: 200,
					operation: "",
					error: "",
					error_code: 0,
					metadata: ["/1.0/projects/default"],
				}),
				{ status: 200 },
			);
		};
		try {
			await Promise.all([ensureProjects(["name"]), ensureProjects(["name"])]);
			assert.equal(calls, 1);
		} finally {
			globalThis.fetch = previous;
			resetProjectsForTests();
		}
	});

	it("403 is surfaced and not retried", async () => {
		resetProjectsForTests();
		let calls = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			calls += 1;
			return new Response(
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
		};
		try {
			await ensureProjects(["name"]);
			const first = readProjects(["name"]);
			assert.equal(first.error?.status, 403);
			assert.equal(calls, 1);
			await ensureProjects(["name"]);
			assert.equal(calls, 1);
		} finally {
			globalThis.fetch = previous;
			resetProjectsForTests();
		}
	});

	it("404 on one project is an error and does not invent a project object", async () => {
		resetProjectsForTests();
		let calls = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					type: "error",
					error: "Not found",
					error_code: 404,
					status: "",
					status_code: 0,
					operation: "",
					metadata: null,
				}),
				{ status: 404 },
			);
		};
		try {
			await ensureProject("missing", ["name"]);
			const result = readProject("missing", ["name"]);
			assert.equal(result.available, false);
			assert.equal(result.data, undefined);
			assert.equal(result.error?.status, 404);
			await ensureProject("missing", ["name"]);
			assert.equal(calls, 1);
		} finally {
			globalThis.fetch = previous;
			resetProjectsForTests();
		}
	});

	it("empty list is complete", async () => {
		resetProjectsForTests();
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
					metadata: [],
				}),
				{ status: 200 },
			);
		try {
			await ensureProjects(["name"]);
			const result = readProjects(["name"]);
			assert.deepEqual(result.data, []);
			assert.equal(result.complete, true);
			assert.equal(result.fresh, true);
		} finally {
			globalThis.fetch = previous;
			resetProjectsForTests();
		}
	});
});

describe("incus responses", () => {
	it("returns sync metadata for project urls", async () => {
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
					metadata: ["/1.0/projects/default"],
				}),
				{ status: 200 },
			);
		try {
			const result = await incusRequest<string[]>("/1.0/projects");
			assert.deepEqual(result.metadata, ["/1.0/projects/default"]);
		} finally {
			globalThis.fetch = previous;
		}
	});
});
