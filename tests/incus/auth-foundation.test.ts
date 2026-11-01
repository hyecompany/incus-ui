// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthStorage } from "../../src/lib/incus/auth-storage.ts";
import { enrollCertificate } from "../../src/lib/incus/certificates.ts";
import { detectPlatform } from "../../src/lib/platform.ts";

function memoryStorage() {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
		removeItem: (k: string) => void data.delete(k),
	};
}

describe("auth storage", () => {
	it("stores only method, token exp and resume step, and clears them", () => {
		const mem = memoryStorage();
		const store = createAuthStorage(mem);
		store.setLastMethod("tls-token");
		store.setTokenExp(1_900_000_000);
		store.setResume("tls-browser-import");
		assert.equal(store.lastMethod(), "tls-token");
		assert.equal(store.tokenExp(), 1_900_000_000);
		assert.equal(store.resume(), "tls-browser-import");
		store.clear();
		assert.equal(mem.data.size, 0);
	});

	it("survives unavailable storage", () => {
		const store = createAuthStorage({
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
			removeItem: () => undefined,
		});
		store.setLastMethod("oidc");
		assert.equal(store.lastMethod(), null);
		assert.equal(createAuthStorage(null).tokenExp(), null);
	});
});

describe("platform detection", () => {
	const ua = {
		chromeLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
		firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0",
		safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
		edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
		chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
	};
	it("detects OS and browser from the user agent", () => {
		assert.deepEqual(detectPlatform({ userAgent: ua.chromeLinux }), { os: "linux", browser: "chrome" });
		assert.deepEqual(detectPlatform({ userAgent: ua.firefoxMac }), { os: "macos", browser: "firefox" });
		assert.deepEqual(detectPlatform({ userAgent: ua.safariMac }), { os: "macos", browser: "safari" });
		assert.deepEqual(detectPlatform({ userAgent: ua.edgeWin }), { os: "windows", browser: "edge" });
		assert.deepEqual(detectPlatform({ userAgent: ua.chromeOs }), { os: "chromeos", browser: "chrome" });
	});
	it("prefers client hints and spots iPadOS posing as a Mac", () => {
		assert.equal(detectPlatform({ userAgent: ua.chromeLinux, userAgentData: { platform: "macOS" } }).os, "macos");
		assert.equal(detectPlatform({ userAgent: ua.safariMac, maxTouchPoints: 5 }).os, "ios");
	});
});

describe("certificate enrollment", () => {
	const reply = (status: number, error = "") =>
		(async (_url: string, init: RequestInit) => {
			reply.last = init;
			return status === 200
				? new Response(JSON.stringify({ type: "sync", status_code: 200, metadata: {} }), { status })
				: new Response(JSON.stringify({ type: "error", error_code: status, error }), { status });
		}) as unknown as typeof fetch;
	reply.last = undefined as RequestInit | undefined;

	it("posts the token, and the certificate when given", async () => {
		const result = await enrollCertificate({ trustToken: " tok ", certificatePem: "PEM" }, { fetchImpl: reply(200) });
		assert.deepEqual(result, { ok: true });
		assert.equal(reply.last?.method, "POST");
		assert.equal(reply.last?.body, '{"trust_token":"tok","certificate":"PEM"}');
	});

	it("explains the known failures", async () => {
		const reason = async (status: number, error: string) => {
			const r = await enrollCertificate({ trustToken: "t" }, { fetchImpl: reply(status, error) });
			return r.ok ? "ok" : r.reason;
		};
		assert.equal(await reason(403, "No matching certificate add operation found"), "invalid-token");
		assert.equal(await reason(400, "Client is already trusted"), "already-trusted");
		assert.equal(await reason(400, "No client certificate provided"), "no-certificate");
		assert.equal(await reason(403, "Certificate isn't signed by the CA"), "not-ca-signed");
		assert.equal(await reason(500, "boom"), "other");
	});
});
