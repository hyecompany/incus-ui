// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decodeTokenClaims,
	describeTokenFailure,
	forgetTokenSignIn,
	loginWithToken,
	logoutToken,
	normalizeToken,
	rememberTokenSignIn,
	shouldOfferNewToken,
	supportsTokenLogin,
	tokenSessionEnd,
} from "../../src/lib/incus/tls/client-token.ts";
import { createAuthStorage } from "../../src/lib/incus/auth-storage.ts";
import { parseSession } from "../../src/lib/incus/session.ts";

const b64url = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");
const makeToken = (claims: Record<string, unknown>) =>
	`${b64url({ alg: "ES384", typ: "JWT" })}.${b64url(claims)}.c2lnbmF0dXJl`;

const NOW = 1_800_000_000_000;
const now = () => NOW;
const future = NOW / 1000 + 3600;

function fakeFetch(status: number, body: unknown = {}) {
	const calls: { url: string; init: RequestInit }[] = [];
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(body === null ? null : JSON.stringify(body), {
			status,
		});
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("decodeTokenClaims", () => {
	it("reads exp, nbf and sub without verifying", () => {
		const token = makeToken({ sub: "abc123", exp: 1900, nbf: 1000, iat: 1000 });
		assert.deepEqual(decodeTokenClaims(token), {
			sub: "abc123",
			exp: 1900,
			nbf: 1000,
		});
	});

	it("tolerates whitespace and line breaks from pasting", () => {
		const token = makeToken({ exp: 42 });
		const pasted = `  ${token.slice(0, 10)}\n${token.slice(10, 30)}\r\n\t${token.slice(30)}  \n`;
		assert.equal(decodeTokenClaims(pasted)?.exp, 42);
		assert.equal(normalizeToken(`Bearer ${token}`), token);
	});

	it("rejects input that is not a three-part JWT", () => {
		assert.equal(decodeTokenClaims(""), null);
		assert.equal(decodeTokenClaims("abc.def"), null);
		assert.equal(decodeTokenClaims("a.b.c.d"), null);
		assert.equal(decodeTokenClaims("a..c"), null);
		assert.equal(decodeTokenClaims("a.!!!.c"), null);
		assert.equal(decodeTokenClaims(`a.${b64url("text")}.c`), null);
	});

	it("ignores claims of the wrong type", () => {
		assert.deepEqual(decodeTokenClaims(makeToken({ exp: "soon", sub: 1 })), {});
	});
});

describe("supportsTokenLogin", () => {
	it("maps 405 to supported and 404 to unsupported", async () => {
		const yes = fakeFetch(405);
		assert.equal(await supportsTokenLogin({ fetchImpl: yes.impl }), true);
		assert.equal(yes.calls[0].url, "/tls/login");
		assert.equal(yes.calls[0].init.method, "GET");
		const no = fakeFetch(404);
		assert.equal(await supportsTokenLogin({ fetchImpl: no.impl }), false);
	});

	it("throws a meaningful error for other answers", async () => {
		await assert.rejects(
			supportsTokenLogin({ fetchImpl: fakeFetch(500).impl }),
			/answered 500/,
		);
	});
});

describe("loginWithToken", () => {
	it("sends exactly the bearer header and no body", async () => {
		const token = makeToken({ sub: "fp", exp: future });
		const fake = fakeFetch(200, { type: "sync", status_code: 200, metadata: {} });
		const result = await loginWithToken(`\n ${token} \n`, {
			fetchImpl: fake.impl,
			now,
		});
		assert.deepEqual(result, { ok: true, exp: future });
		assert.equal(fake.calls.length, 1);
		const { url, init } = fake.calls[0];
		assert.equal(url, "/tls/login");
		assert.equal(init.method, "POST");
		assert.equal(init.body, undefined);
		assert.equal(init.credentials, "same-origin");
		assert.deepEqual(init.headers, { Authorization: `Bearer ${token}` });
	});

	it("returns exp null for tokens without one", async () => {
		const fake = fakeFetch(200);
		const result = await loginWithToken(makeToken({ sub: "fp" }), {
			fetchImpl: fake.impl,
			now,
		});
		assert.deepEqual(result, { ok: true, exp: null });
	});

	it("short-circuits expired tokens without a request", async () => {
		const fake = fakeFetch(200);
		const exp = NOW / 1000 - 1;
		const result = await loginWithToken(makeToken({ exp }), {
			fetchImpl: fake.impl,
			now,
		});
		assert.deepEqual(result, { ok: false, reason: "expired", exp });
		assert.equal(fake.calls.length, 0);
	});

	it("rejects unparseable input locally", async () => {
		const fake = fakeFetch(200);
		const result = await loginWithToken("not a token", { fetchImpl: fake.impl, now });
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.reason, "malformed");
		assert.equal(fake.calls.length, 0);
	});

	it("maps server errors to reasons", async () => {
		const token = makeToken({ exp: future });
		const cases: [number, string, string][] = [
			[403, "Invalid token", "invalid"],
			[400, "Missing bearer token", "malformed"],
			[400, "TLS JWT login requires a TLS connection", "insecure"],
			[404, "not found", "unsupported"],
			[403, "Forbidden Sec-Fetch-Site header value", "other"],
			[500, "boom", "other"],
		];
		for (const [status, error, reason] of cases) {
			const fake = fakeFetch(status, { type: "error", error_code: status, error });
			const result = await loginWithToken(token, { fetchImpl: fake.impl, now });
			assert.equal(result.ok, false);
			assert.equal(!result.ok && result.reason, reason, `${status} ${error}`);
			assert.equal(result.exp, future);
		}
	});

	it("keeps the server message for unknown errors, never the token", async () => {
		const token = makeToken({ exp: future });
		const fake = fakeFetch(500, { type: "error", error: "boom" });
		const result = await loginWithToken(token, { fetchImpl: fake.impl, now });
		assert.deepEqual(result, { ok: false, reason: "other", exp: future, message: "boom" });
		assert.ok(!JSON.stringify(result).includes(token));
	});

	it("maps transport failures to network", async () => {
		const failing = (async () => {
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;
		const result = await loginWithToken(makeToken({}), { fetchImpl: failing, now });
		assert.deepEqual(result, { ok: false, reason: "network", exp: null });
	});
});

describe("logoutToken", () => {
	it("posts to /tls/logout and tolerates 404", async () => {
		const fake = fakeFetch(200);
		await logoutToken({ fetchImpl: fake.impl });
		assert.equal(fake.calls[0].url, "/tls/logout");
		assert.equal(fake.calls[0].init.method, "POST");
		await logoutToken({ fetchImpl: fakeFetch(404, null).impl });
		await assert.rejects(logoutToken({ fetchImpl: fakeFetch(500).impl }));
	});
});

describe("token failure copy", () => {
	it("names the expiry time and never echoes unknown input", () => {
		const text = describeTokenFailure(
			{ ok: false, reason: "expired", exp: 100 },
			(exp) => `T${exp}`,
		);
		assert.match(text.detail, /T100/);
		for (const reason of ["invalid", "malformed", "unsupported", "insecure", "network", "other"] as const) {
			const copy = describeTokenFailure({ ok: false, reason, exp: null }, String);
			assert.ok(copy.title.length > 0 && copy.detail.length > 0, reason);
		}
		assert.match(describeTokenFailure({ ok: false, reason: "unsupported", exp: null }, String).detail, /7\.6/);
	});

	it("explains why a token session ended", () => {
		assert.deepEqual(tokenSessionEnd(100, 200_000), { kind: "expired", exp: 100 });
		assert.deepEqual(tokenSessionEnd(1_000, 200_000), { kind: "rejected" });
		assert.deepEqual(tokenSessionEnd(null), { kind: "rejected" });
	});
});

describe("token sign-in hints", () => {
	function memoryStorage() {
		const map = new Map<string, string>();
		return {
			map,
			getItem: (key: string) => map.get(key) ?? null,
			setItem: (key: string, value: string) => void map.set(key, value),
			removeItem: (key: string) => void map.delete(key),
		};
	}

	it("stores only the method and exp, and clears resume", () => {
		const mem = memoryStorage();
		const storage = createAuthStorage(mem);
		storage.setResume("tls-browser-import");
		rememberTokenSignIn(storage, 1234);
		assert.equal(storage.lastMethod(), "tls-token");
		assert.equal(storage.tokenExp(), 1234);
		assert.equal(storage.resume(), null);
		assert.deepEqual([...mem.map.values()].sort(), ["1234", "tls-token"]);
		rememberTokenSignIn(storage, null);
		assert.equal(storage.tokenExp(), null);
		forgetTokenSignIn(storage);
		assert.equal(storage.lastMethod(), null);
		assert.equal(mem.map.size, 0);
	});

	it("offers a new token only when untrusted after a token sign-in", () => {
		const untrusted = { status: "ready", session: parseSession({ auth: "untrusted" }) } as const;
		const trusted = { status: "ready", session: parseSession({ auth: "trusted" }) } as const;
		assert.equal(shouldOfferNewToken(untrusted, "tls-token"), true);
		assert.equal(shouldOfferNewToken(untrusted, "tls"), false);
		assert.equal(shouldOfferNewToken(untrusted, null), false);
		assert.equal(shouldOfferNewToken(trusted, "tls-token"), false);
		assert.equal(shouldOfferNewToken({ status: "loading" }, "tls-token"), false);
	});
});
