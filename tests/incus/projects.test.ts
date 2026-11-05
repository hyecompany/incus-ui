// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IncusApiError } from "../../src/lib/incus/client.ts";
import {
	fetchProject,
	fetchProjectNames,
	fetchProjectObjects,
	parseProjectObject,
	projectNameFromUrl,
} from "../../src/lib/incus/projects.ts";

function respond(status: number, body: unknown, seen: string[] = []): typeof fetch {
	return (async (input: string) => {
		seen.push(String(input));
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
}
const sync = (metadata: unknown) => ({ type: "sync", status_code: 200, metadata });
const isKind = (kind: string) => (e: unknown) => e instanceof IncusApiError && e.kind === kind;

describe("project representations", () => {
	it("recursion=0 yields names from URLs, decoding them", async () => {
		const seen: string[] = [];
		const names = await fetchProjectNames({
			fetchImpl: respond(200, sync(["/1.0/projects/default", "/1.0/projects/my%20proj"]), seen),
		});
		assert.deepEqual(names, ["default", "my proj"]);
		assert.deepEqual(seen, ["/1.0/projects"]);
	});

	it("recursion=1 yields details including used_by", async () => {
		const seen: string[] = [];
		const projects = await fetchProjectObjects({
			fetchImpl: respond(
				200,
				sync([{ name: "p", description: "d", config: { "features.images": "true" }, used_by: ["/1.0/instances/x"] }]),
				seen,
			),
		});
		assert.deepEqual(projects, [{ name: "p", description: "d", config: { "features.images": "true" }, usedBy: ["/1.0/instances/x"] }]);
		assert.deepEqual(seen, ["/1.0/projects?recursion=1"]);
	});

	it("an individual GET of a missing project is null (known absence), not an error", async () => {
		const seen: string[] = [];
		const missing = await fetchProject("gone", {
			fetchImpl: respond(404, { type: "error", error_code: 404, error: "Project not found" }, seen),
		});
		assert.equal(missing, null);
		assert.deepEqual(seen, ["/1.0/projects/gone"]);
	});

	it("keeps the meaning of other failures", async () => {
		await assert.rejects(
			fetchProject("p", { fetchImpl: respond(403, { type: "error", error_code: 403, error: "nope" }) }),
			isKind("forbidden"),
		);
		await assert.rejects(fetchProjectNames({ fetchImpl: respond(200, sync({})) }), isKind("malformed"));
		await assert.rejects(fetchProjectNames({ fetchImpl: respond(200, sync([1])) }), isKind("malformed"));
	});
});

describe("parsing", () => {
	it("defaults missing description and config, rejects wrong types", () => {
		assert.deepEqual(parseProjectObject({ name: "p" }, "x"), { name: "p", description: "", config: {}, usedBy: [] });
		assert.throws(() => parseProjectObject({ description: "d" }, "x"), isKind("malformed"));
		assert.throws(() => parseProjectObject({ name: "p", config: { a: 1 } }, "x"), isKind("malformed"));
		assert.throws(() => parseProjectObject({ name: "p", description: 3 }, "x"), isKind("malformed"));
	});

	it("rejects URLs that are not project URLs", () => {
		assert.throws(() => projectNameFromUrl("/1.0/instances/x"), isKind("malformed"));
		assert.throws(() => projectNameFromUrl("/1.0/projects/"), isKind("malformed"));
		assert.equal(projectNameFromUrl("/1.0/projects/p?project=q"), "p");
	});
});
