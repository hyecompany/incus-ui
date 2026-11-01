// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

// Real-server checks; skipped unless INCUS_AUTH_TEST_URL and INCUS_AUTH_TEST_INSTANCE
// (a disposable `incus` instance serving that URL, administered via `incus exec`) are set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { request } from "node:https";
import { after, before, describe, it } from "node:test";
import { enrollCertificate } from "../../src/lib/incus/certificates.ts";
import {
	authScreenOptions,
	parseSession,
} from "../../src/lib/incus/session.ts";
import {
	loginWithToken,
	logoutToken,
	supportsTokenLogin,
} from "../../src/lib/incus/tls/client-token.ts";
import {
	type GeneratedCertificate,
	defaultCommonName,
	generateClientCertificate,
} from "../../src/lib/incus/tls/generate-certificate.ts";

const BASE = process.env.INCUS_AUTH_TEST_URL;
const INSTANCE = process.env.INCUS_AUTH_TEST_INSTANCE;
const skip =
	!BASE || !INSTANCE ? "INCUS_AUTH_TEST_URL/INSTANCE not set" : false;

const inside = (...args: string[]) =>
	execFileSync("incus", ["exec", INSTANCE ?? "", "--", ...args], {
		encoding: "utf8",
	}).trim();

const newTrustToken = (name: string) =>
	inside("incus", "config", "trust", "add", name, "--quiet");

interface TestClient {
	fetch: typeof fetch;
	cookies: Map<string, string>;
	setCookies: string[];
}

// fetch over node:https so the self-signed server cert is accepted and a client cert can be presented.
function testClient(tls: { cert?: string; key?: string } = {}): TestClient {
	const cookies = new Map<string, string>();
	const setCookies: string[] = [];
	const impl = (input: string | URL | Request, init: RequestInit = {}) =>
		new Promise<Response>((resolve, reject) => {
			const url = new URL(String(input), BASE);
			const headers = new Headers(init.headers);
			if (cookies.size > 0) {
				headers.set(
					"cookie",
					[...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
				);
			}
			const req = request(
				url,
				{
					method: init.method ?? "GET",
					headers: Object.fromEntries(headers),
					rejectUnauthorized: false,
					cert: tls.cert,
					key: tls.key,
				},
				(res) => {
					for (const raw of res.headers["set-cookie"] ?? []) {
						setCookies.push(raw);
						const [pair, ...attrs] = raw.split(";");
						const [name, value] = pair.split("=");
						const expired = attrs.some((a) =>
							/expires=thu, 01 jan 1970/i.test(a.trim()),
						);
						if (expired || value === "") cookies.delete(name.trim());
						else cookies.set(name.trim(), value);
					}
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const status = res.statusCode ?? 0;
						const body = status === 204 ? null : Buffer.concat(chunks);
						resolve(new Response(body, { status }));
					});
				},
			);
			req.on("error", reject);
			if (typeof init.body === "string") req.write(init.body);
			req.end();
		});
	return { fetch: impl as typeof fetch, cookies, setCookies };
}

async function getSession(client: TestClient) {
	const res = await client.fetch("/1.0");
	const envelope = (await res.json()) as { metadata: unknown };
	return { raw: envelope.metadata, session: parseSession(envelope.metadata) };
}

const b64url = (data: string | Buffer) =>
	Buffer.from(data).toString("base64url");

function signJwt(
	keyPem: string,
	claims: Record<string, string | number>,
): string {
	const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const body = b64url(JSON.stringify(claims));
	const sig = sign(
		"sha256",
		Buffer.from(`${head}.${body}`),
		createPrivateKey(keyPem),
	);
	return `${head}.${body}.${b64url(sig)}`;
}

describe("auth against a real Incus server", { skip }, () => {
	let cert: GeneratedCertificate;
	const enrolledName = `qa-${Date.now()}`;

	before(async () => {
		cert = await generateClientCertificate({
			commonName: defaultCommonName("auth-qa.test"),
			password: "qa-password",
		});
	});

	after(() => {
		if (!cert) return;
		try {
			inside("incus", "config", "trust", "remove", cert.fingerprint);
		} catch {
			// Not enrolled (an earlier step failed).
		}
	});

	it("untrusted /1.0 exposes auth_methods and user.ui.* only", async () => {
		const { raw, session } = await getSession(testClient());
		assert.equal(session.trusted, false);
		assert.ok(session.authMethods.includes("tls"));
		assert.equal((raw as { api_extensions: unknown }).api_extensions, null);
	});

	it("reflects user.ui.auth.* and the legacy user.ui.sso_only before sign-in", async () => {
		inside(
			"incus",
			"config",
			"set",
			"user.ui.auth.offer_cli=false",
			"user.ui.sso_only=true",
			"user.other=hidden",
		);
		try {
			const { raw, session } = await getSession(testClient());
			assert.deepEqual((raw as { config: unknown }).config, {
				"user.ui.auth.offer_cli": "false",
				"user.ui.sso_only": "true",
			});
			assert.deepEqual(authScreenOptions(session.uiConfig), {
				offerCli: false,
				autoInitOidc: true,
			});
		} finally {
			inside("incus", "config", "unset", "user.ui.auth.offer_cli");
			inside("incus", "config", "unset", "user.ui.sso_only");
			inside("incus", "config", "unset", "user.other");
		}
		const { raw } = await getSession(testClient());
		assert.deepEqual((raw as { config: unknown }).config, {});
	});

	it("feature-detects /tls/login", async () => {
		assert.equal(
			await supportsTokenLogin({ fetchImpl: testClient().fetch }),
			true,
		);
	});

	it("reports a bogus trust token as invalid-token", async () => {
		const result = await enrollCertificate(
			{ trustToken: "bm90LWEtdG9rZW4=", certificatePem: cert.certificatePem },
			{ fetchImpl: testClient().fetch },
		);
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.reason, "invalid-token");
	});

	it("reports no-certificate when no body cert and no TLS cert are sent", async () => {
		const token = newTrustToken(`${enrolledName}-none`);
		try {
			const result = await enrollCertificate(
				{ trustToken: token },
				{ fetchImpl: testClient().fetch },
			);
			assert.equal(!result.ok && result.reason, "no-certificate");
		} finally {
			inside(
				"sh",
				"-c",
				`incus config trust list-tokens -f csv | grep -q '^${enrolledName}-none,' && incus config trust revoke-token ${enrolledName}-none || true`,
			);
		}
	});

	it("enrolls the generated body certificate, which is then trusted over TLS", async () => {
		const token = newTrustToken(enrolledName);
		const result = await enrollCertificate(
			{ trustToken: `  ${token}\n`, certificatePem: cert.certificatePem },
			{ fetchImpl: testClient().fetch },
		);
		assert.deepEqual(result, { ok: true });

		const reused = await enrollCertificate(
			{ trustToken: token, certificatePem: cert.certificatePem },
			{ fetchImpl: testClient().fetch },
		);
		assert.equal(!reused.ok && reused.reason, "invalid-token");

		const tlsClient = testClient({
			cert: cert.certificatePem,
			key: cert.privateKeyPem,
		});
		const { raw, session } = await getSession(tlsClient);
		assert.equal(session.trusted, true);
		assert.equal(session.authUserMethod, "tls");
		assert.equal(
			(raw as { auth_user_name: string }).auth_user_name,
			cert.fingerprint,
		);
	});

	it("reports already-trusted when a trusted TLS client enrolls without a body", async () => {
		const tlsClient = testClient({
			cert: cert.certificatePem,
			key: cert.privateKeyPem,
		});
		const token = newTrustToken(`${enrolledName}-again`);
		try {
			const result = await enrollCertificate(
				{ trustToken: token },
				{ fetchImpl: tlsClient.fetch },
			);
			assert.equal(result.ok, false);
			assert.equal(!result.ok && result.reason, "already-trusted");
		} finally {
			inside(
				"sh",
				"-c",
				`incus config trust list-tokens -f csv | grep -q '^${enrolledName}-again,' && incus config trust revoke-token ${enrolledName}-again || true`,
			);
		}
	});

	it("signs in with a certificate-signed JWT and signs out via /tls/logout", async () => {
		const now = Math.floor(Date.now() / 1000);
		const jwt = signJwt(cert.privateKeyPem, {
			sub: cert.fingerprint,
			iat: now,
			nbf: now,
			exp: now + 300,
		});
		const client = testClient();

		const result = await loginWithToken(jwt, { fetchImpl: client.fetch });
		assert.deepEqual(result, { ok: true, exp: now + 300 });
		const cookie = client.setCookies.find((c) => c.startsWith("tls_jwt="));
		assert.ok(cookie);
		assert.match(cookie, /HttpOnly/i);
		assert.match(cookie, /Secure/i);
		assert.match(cookie, /SameSite=Strict/i);
		assert.match(cookie, /Path=\//i);

		const { raw, session } = await getSession(client);
		assert.equal(session.trusted, true);
		assert.equal(session.authUserMethod, "tls");
		assert.equal(
			(raw as { auth_user_name: string }).auth_user_name,
			cert.fingerprint,
		);

		await logoutToken({ fetchImpl: client.fetch });
		assert.equal(client.cookies.has("tls_jwt"), false);
		assert.equal((await getSession(client)).session.trusted, false);
	});

	it("rejects expired tokens (client-side and server-side) and untrusted signers", async () => {
		const now = Math.floor(Date.now() / 1000);
		const expired = signJwt(cert.privateKeyPem, {
			sub: cert.fingerprint,
			nbf: now - 600,
			exp: now - 60,
		});
		const client = testClient();

		const local = await loginWithToken(expired, { fetchImpl: client.fetch });
		assert.deepEqual(local, { ok: false, reason: "expired", exp: now - 60 });

		const server = await loginWithToken(expired, {
			fetchImpl: client.fetch,
			now: () => (now - 120) * 1000,
		});
		assert.equal(!server.ok && server.reason, "invalid");

		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const forged = signJwt(
			privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			{ sub: cert.fingerprint, exp: now + 300 },
		);
		const bad = await loginWithToken(forged, { fetchImpl: client.fetch });
		assert.equal(!bad.ok && bad.reason, "invalid");
		assert.equal(client.cookies.has("tls_jwt"), false);
	});

	it("generated files work with `incus remote add --auth-type=tls --tls-cert --tls-key`", () => {
		const dir = "/root/qa-remote";
		inside("mkdir", "-p", dir);
		execFileSync(
			"incus",
			["exec", INSTANCE ?? "", "--", "sh", "-c", `cat > ${dir}/incus-ui.crt`],
			{ input: cert.certificatePem },
		);
		execFileSync(
			"incus",
			[
				"exec",
				INSTANCE ?? "",
				"--",
				"sh",
				"-c",
				`umask 077; cat > ${dir}/incus-ui.key`,
			],
			{ input: cert.privateKeyPem },
		);
		try {
			inside(
				"incus",
				"remote",
				"add",
				"qa",
				"https://127.0.0.1:8443",
				"--accept-certificate",
				"--auth-type=tls",
				"--tls-cert",
				`${dir}/incus-ui.crt`,
				"--tls-key",
				`${dir}/incus-ui.key`,
			);
			assert.match(inside("incus", "query", "qa:/1.0"), /"auth": "trusted"/);
		} finally {
			inside("sh", "-c", `incus remote remove qa 2>/dev/null; rm -rf ${dir}`);
		}
	});

	it("`incus remote get-client-token` prints a JWT the UI can decode", async () => {
		const token = inside(
			"incus",
			"remote",
			"get-client-token",
			"1h",
			"--quiet",
		);
		const parts = token.split(".");
		assert.equal(parts.length, 3);
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
		assert.match(claims.sub, /^[0-9a-f]{64}$/);
		assert.ok(claims.exp > Date.now() / 1000);
		// The CLI's default cert is not trusted over HTTPS here, so the server refuses it.
		const result = await loginWithToken(token, {
			fetchImpl: testClient().fetch,
		});
		assert.equal(!result.ok && result.reason, "invalid");
	});

	it("a second generated .crt can be trusted with `incus config trust add-certificate`", async () => {
		const manual = await generateClientCertificate({
			commonName: defaultCommonName("auth-qa-manual.test"),
			password: "qa-password",
		});
		execFileSync(
			"incus",
			["exec", INSTANCE ?? "", "--", "sh", "-c", "cat > /root/manual.crt"],
			{ input: manual.certificatePem },
		);
		try {
			inside("incus", "config", "trust", "add-certificate", "/root/manual.crt");
			const client = testClient({
				cert: manual.certificatePem,
				key: manual.privateKeyPem,
			});
			assert.equal((await getSession(client)).session.trusted, true);
		} finally {
			inside(
				"sh",
				"-c",
				`rm -f /root/manual.crt; incus config trust remove ${manual.fingerprint} 2>/dev/null || true`,
			);
		}
	});
});
