// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionStore, parseSession } from "../../src/lib/incus/session.ts";

const withoutCapabilities = ({ capabilities: _, ...rest }: ReturnType<typeof parseSession>) => rest;

describe("parseSession", () => {
	it("derives the session key from the real /1.0 fields", () => {
		assert.deepEqual(
			withoutCapabilities(
				parseSession({
					auth: "trusted",
					auth_user_method: "tls",
					auth_user_name: "abc123",
					environment: { certificate_fingerprint: "fp1", server_name: "srv" },
				}),
			),
			{ trusted: true, sessionKey: "fp1/tls:abc123", deploymentId: "fp1" },
		);
	});

	it("reads API extensions as capabilities (#7)", () => {
		const session = parseSession({
			auth: "trusted",
			api_version: "1.0",
			api_extensions: ["api_filtering", "projects"],
			environment: { server_clustered: true },
		});
		assert.equal(session.capabilities.known, true);
		assert.equal(session.capabilities.clustered, true);
		assert.deepEqual([...session.capabilities.extensions], ["api_filtering", "projects"]);
		assert.equal(parseSession({ auth: "trusted" }).capabilities.known, false);
	});

	it("accepts the older auth_method field and falls back to server_name", () => {
		const session = parseSession({
			auth: "trusted",
			auth_method: "oidc",
			auth_user_name: "u",
			environment: { server_name: "srv" },
		});
		assert.equal(session.sessionKey, "srv/oidc:u");
		assert.equal(session.deploymentId, "srv");
	});

	it("separates the same user on different deployments", () => {
		const meta = (fp: string) => ({
			auth: "trusted",
			auth_user_method: "tls",
			auth_user_name: "u",
			environment: { certificate_fingerprint: fp },
		});
		assert.notEqual(parseSession(meta("a")).sessionKey, parseSession(meta("b")).sessionKey);
	});

	it("is untrusted with no key for anything other than trusted", () => {
		const untrusted = { trusted: false, sessionKey: null, deploymentId: null };
		assert.deepEqual(
			withoutCapabilities(parseSession({ auth: "untrusted", auth_methods: ["tls"] })),
			untrusted,
		);
		assert.deepEqual(withoutCapabilities(parseSession(null)), untrusted);
		assert.deepEqual(withoutCapabilities(parseSession("trusted")), untrusted);
	});

	it("falls back to unknown identity fields without collapsing sessions", () => {
		const session = parseSession({ auth: "trusted" });
		assert.equal(session.trusted, true);
		assert.equal(session.sessionKey, "unknown/unknown:unknown");
	});
});

describe("createSessionStore", () => {
	const trusted = {
		type: "sync",
		status_code: 200,
		metadata: {
			auth: "trusted",
			auth_user_method: "tls",
			auth_user_name: "u",
			environment: { certificate_fingerprint: "fp" },
		},
	};
	const flush = async () => {
		for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
	};

	it("loads the session once and publishes it", async () => {
		let calls = 0;
		const store = createSessionStore({
			fetchImpl: (async () => {
				calls += 1;
				return new Response(JSON.stringify(trusted), { status: 200 });
			}) as unknown as typeof fetch,
		});
		assert.equal(store.get().status, "loading");
		await flush();
		const state = store.get();
		assert.equal(state.status === "ready" && state.session.sessionKey, "fp/tls:u");
		assert.equal(calls, 1);
		store.dispose();
	});

	it("retries transient failures a bounded number of times, then reports the error", async () => {
		let calls = 0;
		const store = createSessionStore({
			retryDelaysMs: [1, 1],
			fetchImpl: (async () => {
				calls += 1;
				return new Response(JSON.stringify({ type: "error", error_code: 503, error: "busy" }), { status: 503 });
			}) as unknown as typeof fetch,
		});
		await new Promise((r) => setTimeout(r, 30));
		await flush();
		const state = store.get();
		assert.equal(state.status, "error");
		assert.equal(state.status === "error" && state.error.kind, "server");
		assert.equal(calls, 3);
		store.dispose();
	});
});
