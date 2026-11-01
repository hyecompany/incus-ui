// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IncusApiError } from "../../src/lib/incus/client.ts";
import type { IncusSession, SessionState } from "../../src/lib/incus/session.ts";
import { isWebuiOrigin, signInLabel, signOut } from "../../src/lib/incus/sign-out.ts";

const base: IncusSession = {
	trusted: false,
	authMethods: ["tls"],
	uiConfig: {},
	authUserMethod: null,
	authUserName: null,
	sessionKey: null,
	deploymentId: null,
};

function harness(next: SessionState, respond?: (path: string) => Response) {
	const calls: string[] = [];
	const order: string[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(`${init?.method} ${String(input)}`);
		order.push("fetch");
		return respond ? respond(String(input)) : new Response(null, { status: 200 });
	}) as typeof fetch;
	return {
		calls,
		order,
		deps: {
			fetchImpl,
			authStorage: { clear: () => void order.push("clear") },
			refreshSession: async () => {
				order.push("refresh");
				return next;
			},
			suppressAutoSignIn: () => void order.push("suppress"),
		},
	};
}

describe("signOut", () => {
	it("posts both logout endpoints, clears hints and refreshes", async () => {
		const h = harness({ status: "ready", session: base });
		const result = await signOut(h.deps);
		assert.equal(result.kind, "signed-out");
		assert.deepEqual(h.calls.sort(), ["POST /oidc/logout", "POST /tls/logout"]);
		assert.deepEqual(h.order, ["suppress", "clear", "fetch", "fetch", "refresh"]);
	});

	it("ignores 404s and network failures from logout endpoints", async () => {
		const h = harness({ status: "ready", session: base }, (path) => {
			if (path === "/tls/logout") throw new TypeError("offline");
			return new Response("not found", { status: 404 });
		});
		assert.equal((await signOut(h.deps)).kind, "signed-out");
	});

	it("explains a browser certificate that is still trusted", async () => {
		const session = { ...base, trusted: true, authUserMethod: "tls" };
		const h = harness({ status: "ready", session });
		assert.equal((await signOut(h.deps)).kind, "certificate");
	});

	it("reports other ways of staying trusted", async () => {
		const session = { ...base, trusted: true, authUserMethod: "unix" };
		const h = harness({ status: "ready", session });
		assert.equal((await signOut(h.deps)).kind, "still-trusted");
	});

	it("does not call Incus for incus webui sessions", async () => {
		const h = harness({ status: "ready", session: base });
		const result = await signOut({ ...h.deps, webui: true });
		assert.equal(result.kind, "webui");
		assert.deepEqual(h.calls, []);
		assert.deepEqual(h.order, ["suppress", "clear"]);
	});

	it("surfaces a failed session refresh", async () => {
		const error = new IncusApiError("network", "down");
		const h = harness({ status: "error", error });
		assert.deepEqual(await signOut(h.deps), { kind: "error", error });
	});
});

describe("isWebuiOrigin", () => {
	it("matches the plain-HTTP loopback proxy only", () => {
		assert.equal(isWebuiOrigin({ protocol: "http:", hostname: "127.0.0.1" }), true);
		assert.equal(isWebuiOrigin({ protocol: "http:", hostname: "[::1]" }), true);
		assert.equal(isWebuiOrigin({ protocol: "https:", hostname: "127.0.0.1" }), false);
		assert.equal(isWebuiOrigin({ protocol: "http:", hostname: "localhost" }), false);
	});
});

describe("signInLabel", () => {
	it("names the sign-in method", () => {
		assert.equal(signInLabel("tls", "tls-token", false), "Client token");
		assert.equal(signInLabel("tls", "tls", false), "TLS certificate");
		assert.equal(signInLabel("tls", null, false), "TLS certificate");
		assert.equal(signInLabel("oidc", "oidc", false), "Single sign-on");
		assert.equal(signInLabel("unix", null, false), "Local socket");
		assert.equal(signInLabel("tls", null, true), "incus webui");
	});
});
