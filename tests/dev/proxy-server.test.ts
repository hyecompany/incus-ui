// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import tls from "node:tls";
import { createDevProxyServer, type ProxyConfig } from "../../scripts/incus-dev-proxy.ts";

const APP_TARGET = new URL("http://127.0.0.1:5173");

/**
 * Minimal self-signed RSA certificate for TLS handshake tests.
 * TODO: Replace with the shared cert generator from TLS auth once that lands, so proxy
 * fixtures and product certificate generation stay on one code path.
 */
function makeSelfSigned(commonName: string): { cert: string; key: string; der: Buffer } {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const now = new Date();
	const notBefore = new Date(now.getTime() - 60_000);
	const notAfter = new Date(now.getTime() + 86_400_000);
	const serial = Buffer.alloc(8);
	serial.writeUInt32BE((Math.floor(Math.random() * 0xffffffff) & 0x7fffffff) >>> 0, 0);
	serial.writeUInt32BE(Math.floor(Math.random() * 0xffffffff) >>> 0, 4);

	const sha256WithRsa = derSequence(derOid("1.2.840.113549.1.1.11"), derNull());
	const tbs = derSequence(
		// version v3 as [0] EXPLICIT
		der([0xa0], derInteger(Buffer.from([0x02]))),
		derInteger(serial),
		sha256WithRsa,
		nameSequence(commonName),
		derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
		nameSequence(commonName),
		publicKey.export({ type: "spki", format: "der" }) as Buffer,
		// extensions as [3] EXPLICIT
		der([0xa3], derSequence(subjectAltNameExtension(commonName))),
	);

	const signature = signSha256Rsa(privateKey, tbs);
	const certDer = derSequence(tbs, sha256WithRsa, derBitString(signature));
	const cert = pem("CERTIFICATE", certDer);
	// Validate before returning so TLS failures are easier to diagnose.
	new X509Certificate(cert);
	const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	return { cert, key, der: certDer };
}

function signSha256Rsa(privateKey: KeyObject, data: Buffer): Buffer {
	const signer = createSign("SHA256");
	signer.update(data);
	signer.end();
	return signer.sign(privateKey);
}

function pem(type: string, der: Buffer): string {
	return `-----BEGIN ${type}-----\n${der.toString("base64").match(/.{1,64}/g)?.join("\n")}\n-----END ${type}-----\n`;
}

function der(tag: number | number[], content: Buffer): Buffer {
	const tagBuf = Buffer.from(Array.isArray(tag) ? tag : [tag]);
	return Buffer.concat([tagBuf, encodeLength(content.length), content]);
}

function derSequence(...parts: Buffer[]): Buffer {
	return der(0x30, Buffer.concat(parts));
}

function derSet(...parts: Buffer[]): Buffer {
	return der(0x31, Buffer.concat(parts));
}

function derInteger(value: Buffer): Buffer {
	let body = value;
	if (body.length === 0 || body[0] & 0x80) {
		body = Buffer.concat([Buffer.from([0x00]), body]);
	}
	return der(0x02, body);
}

function derOid(oid: string): Buffer {
	const parts = oid.split(".").map((n) => Number(n));
	const bytes: number[] = [40 * parts[0] + parts[1]];
	for (const part of parts.slice(2)) {
		if (part < 0x80) {
			bytes.push(part);
			continue;
		}
		const stack: number[] = [];
		let value = part;
		stack.push(value & 0x7f);
		value >>= 7;
		while (value > 0) {
			stack.push(0x80 | (value & 0x7f));
			value >>= 7;
		}
		for (let i = stack.length - 1; i >= 0; i--) {
			bytes.push(stack[i]);
		}
	}
	return der(0x06, Buffer.from(bytes));
}

function derNull(): Buffer {
	return Buffer.from([0x05, 0x00]);
}

function derUtf8(text: string): Buffer {
	return der(0x0c, Buffer.from(text, "utf8"));
}

function derUtcTime(date: Date): Buffer {
	const yy = String(date.getUTCFullYear()).slice(2);
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const mi = String(date.getUTCMinutes()).padStart(2, "0");
	const ss = String(date.getUTCSeconds()).padStart(2, "0");
	return der(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`));
}

function derBitString(bytes: Buffer): Buffer {
	return der(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
}

function derOctetString(bytes: Buffer): Buffer {
	return der(0x04, bytes);
}

function encodeLength(length: number): Buffer {
	if (length < 0x80) {
		return Buffer.from([length]);
	}
	if (length < 0x100) {
		return Buffer.from([0x81, length]);
	}
	return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function nameSequence(commonName: string): Buffer {
	return derSequence(
		derSet(derSequence(derOid("2.5.4.3"), derUtf8(commonName))),
	);
}

function subjectAltNameExtension(dnsName: string): Buffer {
	const san = derSequence(der([0x82], Buffer.from(dnsName, "ascii")));
	return derSequence(derOid("2.5.29.17"), derOctetString(san));
}

function listen(server: net.Server | http.Server | https.Server, path?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		if (path !== undefined) {
			server.listen(path, () => resolve());
			return;
		}
		server.listen(0, "127.0.0.1", () => resolve());
	});
}

function trackSockets(server: net.Server, openSockets: Set<net.Socket>): void {
	server.on("connection", (socket) => {
		openSockets.add(socket);
		socket.on("close", () => openSockets.delete(socket));
	});
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function readUpgradeResponse(
	port: number,
	requestPath: string,
	extraHeaders = "",
	timeoutMs = 3000,
): Promise<string> {
	const client = net.connect(port, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		client.once("connect", () => resolve());
		client.once("error", reject);
	});
	client.write(
		`GET ${requestPath} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
	);

	let received = "";
	client.on("data", (chunk: Buffer) => {
		received += chunk.toString();
	});
	await waitFor(() => received.includes("\r\n\r\n"), timeoutMs);
	client.destroy();
	return received;
}

function baseProxyConfig(overrides: Partial<ProxyConfig> & { targets: ProxyConfig["targets"] }): ProxyConfig {
	return {
		port: 0,
		host: "127.0.0.1",
		remote: "test",
		upstream: {},
		crossOriginIsolation: false,
		warnings: [],
		...overrides,
	};
}

describe("proxy forwarding against fake upstreams", { timeout: 15000 }, () => {
	let apiServer: http.Server;
	let appServer: http.Server;
	let proxy: http.Server;
	let proxyBase: string;
	const received: {
		apiPath?: string;
		apiHost?: string;
		apiCookie?: string;
		apiCustom?: string;
		appUpgraded?: boolean;
		apiUpgraded?: boolean;
	} = {};
	const openSockets = new Set<net.Socket>();

	before(async () => {
		apiServer = http.createServer((req, res) => {
			received.apiPath = req.url;
			received.apiHost = req.headers.host;
			received.apiCookie = req.headers.cookie;
			if (req.url === "/1.0/redirect") {
				res.writeHead(302, { location: `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}/1.0` });
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ metadata: { ok: true } }));
		});
		apiServer.on("upgrade", (req, socket) => {
			received.apiUpgraded = true;
			received.apiCookie = req.headers.cookie;
			received.apiCustom = req.headers["x-custom"] as string | undefined;
			socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
			socket.on("data", (more) => socket.write(more));
		});
		trackSockets(apiServer, openSockets);
		await listen(apiServer);

		appServer = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<!doctype html>app");
		});
		appServer.on("upgrade", (_req, socket) => {
			received.appUpgraded = true;
			socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
			socket.end();
		});
		trackSockets(appServer, openSockets);
		await listen(appServer);

		proxy = createDevProxyServer(
			baseProxyConfig({
				crossOriginIsolation: true,
				targets: {
					api: new URL(`http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`),
					app: new URL(`http://127.0.0.1:${(appServer.address() as AddressInfo).port}`),
				},
			}),
		);
		trackSockets(proxy, openSockets);
		await listen(proxy);
		proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
	});

	after(() => {
		for (const socket of openSockets) {
			socket.destroy();
		}
		openSockets.clear();
		for (const server of [proxy, apiServer, appServer]) {
			server.close();
		}
	});

	it("forwards API requests with query and rewritten Host", async () => {
		const response = await fetch(`${proxyBase}/1.0/projects?recursion=1`, { headers: { cookie: "sid=1" } });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { metadata: { ok: true } });
		assert.equal(received.apiPath, "/1.0/projects?recursion=1");
		assert.equal(received.apiHost, `127.0.0.1:${(apiServer.address() as AddressInfo).port}`);
	});

	it("rewrites upstream Location headers onto the proxy origin", async () => {
		const response = await fetch(`${proxyBase}/1.0/redirect`, { redirect: "manual" });
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), `${proxyBase}/1.0`);
	});

	it("serves app routes under /ui with cross-origin isolation headers", async () => {
		const response = await fetch(`${proxyBase}/ui/`);
		assert.equal(await response.text(), "<!doctype html>app");
		assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
		assert.equal(response.headers.get("origin-agent-cluster"), "?1");
	});

	it("omits cross-origin isolation headers when the flag is off", async () => {
		const server = createDevProxyServer(
			baseProxyConfig({
				targets: {
					api: new URL(`http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`),
					app: new URL(`http://127.0.0.1:${(appServer.address() as AddressInfo).port}`),
				},
			}),
		);
		await listen(server);
		try {
			const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ui/`);
			assert.equal(response.headers.get("cross-origin-opener-policy"), null);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it("returns 502 with a Proxy error message when the upstream is unreachable", async () => {
		const closed = http.createServer();
		await listen(closed);
		const port = (closed.address() as AddressInfo).port;
		await new Promise<void>((resolve) => closed.close(() => resolve()));

		const server = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`http://127.0.0.1:${port}`), app: APP_TARGET },
			}),
		);
		await listen(server);
		try {
			const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/1.0`);
			assert.equal(response.status, 502);
			assert.match(await response.text(), /^Proxy error: /);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it("pipes websocket bytes both ways through the upgrade path", async () => {
		const proxyPort = Number(new URL(proxyBase).port);
		const client = net.connect(proxyPort, "127.0.0.1");
		await new Promise<void>((resolve) => client.once("connect", () => resolve()));
		client.write(
			"GET /1.0/events?type=lifecycle HTTP/1.1\r\nHost: localhost:3001\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: sid=2\r\nX-Custom: nope\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n",
		);

		let receivedBytes = "";
		client.on("data", (chunk: Buffer) => {
			receivedBytes += chunk.toString();
		});

		await waitFor(() => receivedBytes.includes("\r\n\r\n"));
		assert.match(receivedBytes, /^HTTP\/1\.1 101/);
		assert.equal(received.apiCookie, "sid=2");
		assert.equal(received.apiCustom, undefined);

		client.write("ping");
		await waitFor(() => receivedBytes.endsWith("ping"));
		client.destroy();
	});

	it("upgrades /ui on the app server, not the API server", async () => {
		received.appUpgraded = false;
		received.apiUpgraded = false;
		const response = await readUpgradeResponse(Number(new URL(proxyBase).port), "/ui/");
		assert.match(response, /^HTTP\/1\.1 101/);
		assert.equal(received.appUpgraded, true);
		assert.equal(received.apiUpgraded, false);
	});

	it("returns a flushed 502 when a websocket upgrade cannot connect", async () => {
		const closed = http.createServer();
		await listen(closed);
		const port = (closed.address() as AddressInfo).port;
		await new Promise<void>((resolve) => closed.close(() => resolve()));

		const server = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`http://127.0.0.1:${port}`), app: APP_TARGET },
			}),
		);
		await listen(server);
		try {
			const response = await readUpgradeResponse((server.address() as AddressInfo).port, "/1.0/events");
			assert.match(response, /^HTTP\/1\.1 502/);
			assert.match(response, /Proxy error: /);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it("returns 502 when the upstream accepts TCP but never responds (HTTP and upgrade)", async () => {
		const previousTimeout = process.env.DEV_PROXY_CONNECT_TIMEOUT_MS;
		process.env.DEV_PROXY_CONNECT_TIMEOUT_MS = "200";
		const hold = net.createServer((socket) => {
			// Accept and drain, but never send an HTTP response.
			socket.on("data", () => {});
		});
		trackSockets(hold, openSockets);
		await listen(hold);
		const holdPort = (hold.address() as AddressInfo).port;

		const server = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`http://127.0.0.1:${holdPort}`), app: APP_TARGET },
			}),
		);
		trackSockets(server, openSockets);
		await listen(server);
		const proxyPort = (server.address() as AddressInfo).port;
		try {
			const response = await fetch(`http://127.0.0.1:${proxyPort}/1.0`);
			assert.equal(response.status, 502);
			assert.match(await response.text(), /upstream connection timed out/);

			const upgrade = await readUpgradeResponse(proxyPort, "/1.0/events", "", 2000);
			assert.match(upgrade, /^HTTP\/1\.1 502/);
			assert.match(upgrade, /upstream connection timed out/);
		} finally {
			if (previousTimeout === undefined) {
				delete process.env.DEV_PROXY_CONNECT_TIMEOUT_MS;
			} else {
				process.env.DEV_PROXY_CONNECT_TIMEOUT_MS = previousTimeout;
			}
			server.closeAllConnections();
			server.close();
			hold.close();
		}
	});

	it("does not inject a 502 after the websocket upgrade has already started", async () => {
		let upstreamSocket: Duplex | undefined;
		const api = http.createServer();
		api.on("upgrade", (_req, socket) => {
			upstreamSocket = socket;
			socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
		});
		trackSockets(api, openSockets);
		await listen(api);

		const server = createDevProxyServer(
			baseProxyConfig({
				targets: {
					api: new URL(`http://127.0.0.1:${(api.address() as AddressInfo).port}`),
					app: APP_TARGET,
				},
			}),
		);
		trackSockets(server, openSockets);
		await listen(server);
		const proxyPort = (server.address() as AddressInfo).port;

		const client = net.connect(proxyPort, "127.0.0.1");
		await new Promise<void>((resolve, reject) => {
			client.once("connect", () => resolve());
			client.once("error", reject);
		});
		client.write(
			"GET /1.0/events HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n",
		);

		let received = "";
		client.on("data", (chunk: Buffer) => {
			received += chunk.toString();
		});
		await waitFor(() => received.includes("\r\n\r\n"));
		assert.match(received, /^HTTP\/1\.1 101/);
		assert.ok(upstreamSocket);

		const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
		upstreamSocket.destroy();
		await closed;

		assert.equal(received.includes("502"), false);
		assert.equal(received.includes("Proxy error:"), false);

		server.closeAllConnections();
		server.close();
		api.close();
	});

	it("destroys the upstream when the client disconnects before the upgrade finishes", async () => {
		let liveUpstreams = 0;
		const hold = net.createServer((socket) => {
			liveUpstreams++;
			// Drain so Windows surfaces peer close while unread bytes are buffered.
			socket.on("data", () => {});
			socket.on("close", () => {
				liveUpstreams--;
			});
		});
		trackSockets(hold, openSockets);
		await listen(hold);

		const server = createDevProxyServer(
			baseProxyConfig({
				targets: {
					api: new URL(`http://127.0.0.1:${(hold.address() as AddressInfo).port}`),
					app: APP_TARGET,
				},
			}),
		);
		trackSockets(server, openSockets);
		await listen(server);
		const proxyPort = (server.address() as AddressInfo).port;

		const client = net.connect(proxyPort, "127.0.0.1");
		await new Promise<void>((resolve, reject) => {
			client.once("connect", () => resolve());
			client.once("error", reject);
		});
		client.write(
			"GET /1.0/events HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n",
		);

		await waitFor(() => liveUpstreams === 1);
		client.destroy();
		await waitFor(() => liveUpstreams === 0);

		server.closeAllConnections();
		server.close();
		hold.close();
	});
});

describe("proxy TLS to a pinned upstream", { timeout: 20000 }, () => {
	const serverIdentity = makeSelfSigned("incus.invalid");
	const otherIdentity = makeSelfSigned("other.invalid");
	const clientIdentity = makeSelfSigned("client.invalid");
	const openSockets = new Set<net.Socket>();
	let tlsServer: https.Server;
	let peerCertDer: Buffer | undefined;
	let serverPort: number;

	before(async () => {
		tlsServer = https.createServer(
			{
				key: serverIdentity.key,
				cert: serverIdentity.cert,
				requestCert: true,
				rejectUnauthorized: false,
			},
			(req, res) => {
				const socket = req.socket as tls.TLSSocket;
				peerCertDer = socket.getPeerCertificate().raw;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ path: req.url }));
			},
		);
		tlsServer.on("upgrade", (_req, socket) => {
			const tlsSocket = socket as tls.TLSSocket;
			peerCertDer = tlsSocket.getPeerCertificate().raw;
			socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
			socket.end();
		});
		trackSockets(tlsServer, openSockets);
		await listen(tlsServer);
		serverPort = (tlsServer.address() as AddressInfo).port;
	});

	after(() => {
		for (const socket of openSockets) {
			socket.destroy();
		}
		openSockets.clear();
		tlsServer.close();
	});

	it("presents the client certificate and trusts the pinned server certificate over HTTP", async () => {
		peerCertDer = undefined;
		const proxy = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`https://127.0.0.1:${serverPort}`), app: APP_TARGET },
				upstream: {
					clientCert: clientIdentity.cert,
					clientKey: clientIdentity.key,
					serverCert: serverIdentity.cert,
				},
			}),
		);
		await listen(proxy);
		try {
			const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/1.0`);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { path: "/1.0" });
			assert.ok(peerCertDer);
			assert.deepEqual(peerCertDer, new X509Certificate(clientIdentity.cert).raw);
		} finally {
			proxy.closeAllConnections();
			proxy.close();
		}
	});

	it("presents the client certificate on a websocket upgrade", async () => {
		peerCertDer = undefined;
		const proxy = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`https://127.0.0.1:${serverPort}`), app: APP_TARGET },
				upstream: {
					clientCert: clientIdentity.cert,
					clientKey: clientIdentity.key,
					serverCert: serverIdentity.cert,
				},
			}),
		);
		await listen(proxy);
		try {
			const response = await readUpgradeResponse((proxy.address() as AddressInfo).port, "/1.0/events");
			assert.match(response, /^HTTP\/1\.1 101/);
			assert.ok(peerCertDer);
			assert.deepEqual(peerCertDer, new X509Certificate(clientIdentity.cert).raw);
		} finally {
			proxy.closeAllConnections();
			proxy.close();
		}
	});

	it("returns 502 when the pinned certificate does not match the server", async () => {
		const proxy = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`https://127.0.0.1:${serverPort}`), app: APP_TARGET },
				upstream: {
					clientCert: clientIdentity.cert,
					clientKey: clientIdentity.key,
					serverCert: otherIdentity.cert,
				},
			}),
		);
		await listen(proxy);
		try {
			const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/1.0`);
			assert.equal(response.status, 502);
			assert.match(await response.text(), /^Proxy error: /);

			const upgrade = await readUpgradeResponse((proxy.address() as AddressInfo).port, "/1.0/events");
			assert.match(upgrade, /^HTTP\/1\.1 502/);
			assert.match(upgrade, /Proxy error: /);
		} finally {
			proxy.closeAllConnections();
			proxy.close();
		}
	});

	it("returns 502 when the server requires a client certificate and none is configured", async () => {
		const strict = https.createServer(
			{
				key: serverIdentity.key,
				cert: serverIdentity.cert,
				requestCert: true,
				rejectUnauthorized: true,
			},
			(_req, res) => {
				res.writeHead(200);
				res.end("ok");
			},
		);
		await listen(strict);
		const port = (strict.address() as AddressInfo).port;
		const proxy = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`https://127.0.0.1:${port}`), app: APP_TARGET },
				upstream: { serverCert: serverIdentity.cert },
			}),
		);
		await listen(proxy);
		try {
			const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/1.0`);
			assert.equal(response.status, 502);
			assert.match(await response.text(), /^Proxy error: /);
		} finally {
			proxy.closeAllConnections();
			proxy.close();
			strict.closeAllConnections();
			strict.close();
		}
	});

	it("returns a flushed 502 on websocket upgrade when a client certificate is required and missing", async () => {
		const strict = https.createServer(
			{
				key: serverIdentity.key,
				cert: serverIdentity.cert,
				requestCert: true,
				rejectUnauthorized: true,
			},
			(_req, res) => {
				res.writeHead(200);
				res.end("ok");
			},
		);
		await listen(strict);
		const port = (strict.address() as AddressInfo).port;
		const proxy = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`https://127.0.0.1:${port}`), app: APP_TARGET },
				upstream: { serverCert: serverIdentity.cert },
			}),
		);
		await listen(proxy);
		try {
			const upgrade = await readUpgradeResponse((proxy.address() as AddressInfo).port, "/1.0/events");
			assert.match(upgrade, /^HTTP\/1\.1 502/);
			assert.match(upgrade, /Proxy error: /);
		} finally {
			proxy.closeAllConnections();
			proxy.close();
			strict.closeAllConnections();
			strict.close();
		}
	});

	it("trusts a pinned certificate whose hostname does not match the connect address", async () => {
		peerCertDer = undefined;
		assert.equal(serverIdentity.cert.includes("127.0.0.1"), false);
		const proxy = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL(`https://127.0.0.1:${serverPort}`), app: APP_TARGET },
				upstream: {
					clientCert: clientIdentity.cert,
					clientKey: clientIdentity.key,
					serverCert: serverIdentity.cert,
				},
			}),
		);
		await listen(proxy);
		try {
			const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/1.0`);
			assert.equal(response.status, 200);
			assert.ok(peerCertDer);
		} finally {
			proxy.closeAllConnections();
			proxy.close();
		}
	});
});

describe("proxy forwarding to a unix socket (local remote)", { timeout: 15000 }, () => {
	it("forwards API requests over the socket", async (t) => {
		if (process.platform === "win32") {
			t.skip("Node cannot listen on unix sockets on Windows");
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "incus-dev-proxy-sock-"));
		const socketPath = join(dir, "unix.socket");
		const openSockets = new Set<net.Socket>();
		const socketServer = http.createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json", "x-host": req.headers.host ?? "" });
			res.end(JSON.stringify({ path: req.url }));
		});
		trackSockets(socketServer, openSockets);
		await listen(socketServer, socketPath);

		const proxy = createDevProxyServer(
			baseProxyConfig({
				targets: { api: new URL("http://localhost/"), app: APP_TARGET },
				remote: "local",
				upstream: { socketPath },
			}),
		);
		await listen(proxy);
		const proxyPort = (proxy.address() as AddressInfo).port;
		try {
			const response = await fetch(`http://127.0.0.1:${proxyPort}/1.0?x=1`);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { path: "/1.0?x=1" });
			assert.equal(response.headers.get("x-host"), "localhost");
		} finally {
			for (const socket of openSockets) {
				socket.destroy();
			}
			proxy.closeAllConnections();
			proxy.close();
			socketServer.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
