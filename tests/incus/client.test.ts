// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildIncusUrl,
	IncusApiError,
	incusRequest,
	onAuthFailure,
} from "../../src/lib/incus/client.ts";

interface Recorded {
	url: string;
	init: RequestInit | undefined;
}

function syncBody(metadata: unknown): string {
	return JSON.stringify({
		type: "sync",
		status: "Success",
		status_code: 200,
		operation: "",
		error_code: 0,
		error: "",
		metadata,
	});
}

function errorBody(status: number, code: number, error: string): string {
	return JSON.stringify({
		type: "error",
		status: "Error",
		status_code: status,
		error_code: code,
		error,
		metadata: null,
	});
}

function respondWith(response: Response): { fetchImpl: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return response;
	}) as typeof fetch;

	return { fetchImpl, calls };
}

function failWith(error: unknown): typeof fetch {
	return (async () => {
		throw error;
	}) as typeof fetch;
}

async function captureError(promise: Promise<unknown>): Promise<IncusApiError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof IncusApiError, `expected IncusApiError, got ${String(error)}`);
		return error;
	}
	assert.fail("expected the request to reject");
}

describe("buildIncusUrl", () => {
	it("returns the bare path when no query is given", () => {
		assert.equal(buildIncusUrl("/1.0/projects"), "/1.0/projects");
	});

	it("drops undefined query values", () => {
		assert.equal(
			buildIncusUrl("/1.0/projects", { recursion: "1", project: undefined }),
			"/1.0/projects?recursion=1",
		);
	});

	it("preserves existing params already on the path", () => {
		assert.equal(
			buildIncusUrl("/1.0/instances?filter=x", { recursion: "1" }),
			"/1.0/instances?filter=x&recursion=1",
		);
	});

	it("lets query values override a conflicting path param", () => {
		assert.equal(
			buildIncusUrl("/1.0/instances?project=a", { project: "b" }),
			"/1.0/instances?project=b",
		);
	});

	it("rejects paths that are not absolute same-origin paths", () => {
		assert.throws(() => buildIncusUrl("1.0/projects"));
		assert.throws(() => buildIncusUrl("//evil.example/1.0"));
		assert.throws(() => buildIncusUrl("https://evil.example/1.0"));
	});
});

describe("incusRequest", () => {
	it("returns the envelope metadata on a sync response", async () => {
		const { fetchImpl } = respondWith(new Response(syncBody({ ok: true }), { status: 200 }));

		const result = await incusRequest<{ ok: boolean }>("/1.0", { fetchImpl });

		assert.deepEqual(result, { ok: true });
	});

	it("sends a same-origin GET with credentials and the query applied", async () => {
		const controller = new AbortController();
		const { fetchImpl, calls } = respondWith(new Response(syncBody([]), { status: 200 }));

		await incusRequest("/1.0/projects", {
			query: { recursion: "1" },
			signal: controller.signal,
			fetchImpl,
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "/1.0/projects?recursion=1");
		assert.equal(calls[0].init?.method, "GET");
		assert.equal(calls[0].init?.credentials, "same-origin");
		assert.equal(calls[0].init?.signal, controller.signal);
	});

	it("maps 401 to auth and keeps the status and Incus error code", async () => {
		const { fetchImpl } = respondWith(
			new Response(errorBody(401, 401, "Not authorized"), { status: 401 }),
		);

		const error = await captureError(incusRequest("/1.0", { fetchImpl }));

		assert.equal(error.kind, "auth");
		assert.equal(error.status, 401);
		assert.equal(error.code, 401);
		assert.equal(error.message, "Not authorized");
	});

	it("maps 403 to forbidden", async () => {
		const { fetchImpl } = respondWith(
			new Response(errorBody(403, 403, "Forbidden"), { status: 403 }),
		);

		const error = await captureError(incusRequest("/1.0/projects", { fetchImpl }));

		assert.equal(error.kind, "forbidden");
		assert.equal(error.status, 403);
	});

	it("maps 404 to not-found", async () => {
		const { fetchImpl } = respondWith(
			new Response(errorBody(404, 404, "Not found"), { status: 404 }),
		);

		const error = await captureError(incusRequest("/1.0/projects/x", { fetchImpl }));

		assert.equal(error.kind, "not-found");
	});

	it("maps 5xx to server even when the body is not JSON", async () => {
		const { fetchImpl } = respondWith(
			new Response("<html>Bad Gateway</html>", { status: 502 }),
		);

		const error = await captureError(incusRequest("/1.0", { fetchImpl }));

		assert.equal(error.kind, "server");
		assert.equal(error.status, 502);
		assert.equal(error.message, "HTTP 502");
	});

	it("maps a 200 with non-JSON body to malformed", async () => {
		const { fetchImpl } = respondWith(new Response("not json", { status: 200 }));

		const error = await captureError(incusRequest("/1.0", { fetchImpl }));

		assert.equal(error.kind, "malformed");
	});

	it("maps a 200 with a wrong envelope to malformed", async () => {
		const { fetchImpl } = respondWith(new Response(JSON.stringify({ hello: 1 }), { status: 200 }));

		const error = await captureError(incusRequest("/1.0", { fetchImpl }));

		assert.equal(error.kind, "malformed");
	});

	it("maps an unsupported envelope type to malformed", async () => {
		const body = JSON.stringify({ type: "weird", status_code: 200, metadata: {} });
		const { fetchImpl } = respondWith(new Response(body, { status: 200 }));

		const error = await captureError(incusRequest("/1.0", { fetchImpl }));

		assert.equal(error.kind, "malformed");
	});

	it("sends method, JSON body and extra headers", async () => {
		const seen: RequestInit[] = [];
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			seen.push(init);
			return new Response(JSON.stringify({ type: "sync", status_code: 200, metadata: {} }), { status: 200 });
		}) as unknown as typeof fetch;
		await incusRequest("/1.0/certificates", {
			method: "POST",
			body: { trust_token: "t" },
			headers: { Authorization: "Bearer x" },
			fetchImpl,
		});
		assert.equal(seen[0]?.method, "POST");
		assert.equal(seen[0]?.body, '{"trust_token":"t"}');
		const headers = seen[0]?.headers as Record<string, string>;
		assert.equal(headers.Authorization, "Bearer x");
		assert.equal(headers["Content-Type"], "application/json");
	});

	it("retries once on 305 (incus webui OIDC refresh) and accepts async envelopes", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return calls === 1
				? new Response("", { status: 305 })
				: new Response(JSON.stringify({ type: "async", status_code: 202, metadata: { id: "op" } }), { status: 202 });
		}) as unknown as typeof fetch;
		const metadata = await incusRequest<{ id: string }>("/1.0/instances", { method: "POST", fetchImpl });
		assert.equal(calls, 2);
		assert.equal(metadata.id, "op");
	});

	it("notifies auth-failure listeners on 401/403 only", async () => {
		const seen: string[] = [];
		const stop = onAuthFailure((error, path) => seen.push(`${error.kind}:${path}`));
		const reply = (status: number) =>
			(async () => new Response(JSON.stringify({ type: "error", error_code: status, error: "x" }), { status })) as unknown as typeof fetch;
		await captureError(incusRequest("/1.0/instances", { fetchImpl: reply(403) }));
		await captureError(incusRequest("/1.0/instances", { fetchImpl: reply(500) }));
		stop();
		await captureError(incusRequest("/1.0/instances", { fetchImpl: reply(401) }));
		assert.deepEqual(seen, ["forbidden:/1.0/instances"]);
	});

	it("maps a fetch TypeError to network", async () => {
		const error = await captureError(
			incusRequest("/1.0", { fetchImpl: failWith(new TypeError("fetch failed")) }),
		);

		assert.equal(error.kind, "network");
	});

	it("maps an AbortError to aborted", async () => {
		const abort = new DOMException("The operation was aborted.", "AbortError");

		const error = await captureError(
			incusRequest("/1.0", { fetchImpl: failWith(abort) }),
		);

		assert.equal(error.kind, "aborted");
	});
});
