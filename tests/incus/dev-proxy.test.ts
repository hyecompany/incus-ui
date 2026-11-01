// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
	allowsSelfSignedUpstream,
	createDevProxyServer,
	filterUpgradeHeaders,
	isApiPath,
	parseConfig,
	parseListenerMode,
	type ProxyConfig,
	resolveTarget,
	rewriteLocation,
	shouldUseHttpsListener,
} from "../../scripts/incus-dev-proxy.ts";

const TARGETS = {
	api: new URL("https://localhost:8443"),
	app: new URL("http://127.0.0.1:5173"),
};

describe("parseListenerMode", () => {
	it("defaults to auto and normalizes case", () => {
		assert.equal(parseListenerMode(undefined), "auto");
		assert.equal(parseListenerMode("HTTPS"), "https");
		assert.equal(parseListenerMode("Http"), "http");
	});

	it("rejects unknown values", () => {
		assert.throws(() => parseListenerMode("tcp"), /Invalid DEV_PROXY_LISTENER_MODE value tcp/);
	});
});

describe("shouldUseHttpsListener", () => {
	it("uses https in auto mode unless upstream PFX is enabled", () => {
		assert.equal(shouldUseHttpsListener("auto", false), true);
		assert.equal(shouldUseHttpsListener("auto", true), false);
	});

	it("respects explicit modes", () => {
		assert.equal(shouldUseHttpsListener("http", false), false);
		assert.equal(shouldUseHttpsListener("https", true), true);
	});
});

describe("routing", () => {
	it("treats only /ui and /ui/... as app paths", () => {
		assert.equal(isApiPath("/ui"), false);
		assert.equal(isApiPath("/ui/"), false);
		assert.equal(isApiPath("/ui/instances"), false);
		assert.equal(isApiPath("/uix"), true);
		assert.equal(isApiPath("/1.0/projects"), true);
	});

	it("keeps path and query when resolving the upstream", () => {
		const api = resolveTarget("/1.0/projects?recursion=1", TARGETS);
		assert.equal(api.isApi, true);
		assert.equal(api.url.href, "https://localhost:8443/1.0/projects?recursion=1");

		const app = resolveTarget("/ui/instances?x=1", TARGETS);
		assert.equal(app.isApi, false);
		assert.equal(app.url.href, "http://127.0.0.1:5173/ui/instances?x=1");
	});

	it("never lets a request path change the upstream host", () => {
		const resolved = resolveTarget("//evil.example/steal", TARGETS);
		assert.equal(resolved.url.host, "localhost:8443");
	});
});

describe("rewriteLocation", () => {
	it("rewrites same-host API redirects onto the incoming origin", () => {
		const location = rewriteLocation("https://localhost:8443/1.0/instances", TARGETS.api, "http://localhost:3001", true);
		assert.equal(location, "http://localhost:3001/1.0/instances");
	});

	it("adds the /ui prefix for app redirects that lack it", () => {
		assert.equal(rewriteLocation("/login", TARGETS.app, "http://localhost:3001", false), "http://localhost:3001/ui/login");
		assert.equal(rewriteLocation("/ui/login", TARGETS.app, "http://localhost:3001", false), "http://localhost:3001/ui/login");
	});

	it("leaves redirects to other hosts untouched", () => {
		const external = "https://idp.example/authorize";
		assert.equal(rewriteLocation(external, TARGETS.api, "http://localhost:3001", true), external);
	});
});

describe("upstream trust and websocket headers", () => {
	it("allows self-signed only for https://localhost:8443", () => {
		assert.equal(allowsSelfSignedUpstream(new URL("https://localhost:8443")), true);
		assert.equal(allowsSelfSignedUpstream(new URL("https://incus.example:8443")), false);
		assert.equal(allowsSelfSignedUpstream(new URL("http://localhost:8443")), false);
	});

	it("keeps only the allowlisted headers for API websockets", () => {
		const headers = {
			host: "localhost:3001",
			cookie: "a=1",
			authorization: "Bearer x",
			"user-agent": "ua",
			"sec-websocket-key": "k",
			"sec-websocket-version": "13",
			upgrade: "websocket",
			connection: "Upgrade",
			origin: "http://localhost:3001",
			"x-custom": "nope",
		};
		const names = filterUpgradeHeaders(headers, true).map(([name]) => name.toLowerCase());
		assert.deepEqual(names.sort(), ["authorization", "connection", "cookie", "sec-websocket-key", "sec-websocket-version", "upgrade", "user-agent"]);
	});

	it("forwards all non-host headers for app websockets (Vite HMR)", () => {
		const names = filterUpgradeHeaders({ host: "x", origin: "o", "sec-websocket-protocol": "vite-hmr" }, false).map(
			([name]) => name,
		);
		assert.deepEqual(names, ["origin", "sec-websocket-protocol"]);
	});
});

describe("parseConfig", () => {
	it("applies defaults for the new env vars", () => {
		const config = parseConfig({});
		assert.equal(config.host, "127.0.0.1");
		assert.equal(config.port, 3001);
		assert.equal(config.targets.api.href, "https://localhost:8443/");
		assert.equal(config.targets.app.href, "http://127.0.0.1:5173/");
		assert.equal(config.upstreamPfx, null);
		assert.equal(config.crossOriginIsolation, false);
	});

	it("reads PFX settings without exposing the passphrase in errors", () => {
		const config = parseConfig({
			DEV_PROXY_UPSTREAM_CLIENT_PFX: "1",
			DEV_PROXY_UPSTREAM_CLIENT_PFX_PATH: "./client.pfx",
			DEV_PROXY_UPSTREAM_CLIENT_PFX_PASSPHRASE: "s3cret",
		});
		assert.deepEqual(config.upstreamPfx, { path: "./client.pfx", passphrase: "s3cret" });
	});

	it("reads the listen host", () => {
		assert.equal(parseConfig({ DEV_PROXY_HOST: "10.1.1.240" }).host, "10.1.1.240");
	});

	it("rejects an invalid port", () => {
		assert.throws(() => parseConfig({ DEV_PROXY_PORT: "70000" }), /Invalid DEV_PROXY_PORT/);
	});
});

// Integration: real sockets against fake upstreams. No Incus and no Vite are involved.
describe("proxy forwarding against fake upstreams", { timeout: 15000 }, () => {
	let apiServer: http.Server;
	let appServer: http.Server;
	let proxy: http.Server;
	let proxyBase: string;
	const received: { apiPath?: string; apiHost?: string; apiCookie?: string } = {};
	// Upgraded sockets outlive server.close(), so every accepted socket is tracked and destroyed in teardown.
	const openSockets = new Set<net.Socket>();
	const track = (server: net.Server) => {
		server.on("connection", (socket) => {
			openSockets.add(socket);
			socket.on("close", () => openSockets.delete(socket));
		});
	};

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
		// Upgraded sockets answer with 101, then echo bytes back.
		apiServer.on("upgrade", (req, socket) => {
			received.apiCookie = req.headers.cookie;
			socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
			socket.on("data", (more) => socket.write(more));
		});
		track(apiServer);
		await listen(apiServer);

		appServer = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<!doctype html>app");
		});
		track(appServer);
		await listen(appServer);

		const config: ProxyConfig = {
			port: 0,
			host: "127.0.0.1",
			targets: {
				api: new URL(`http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`),
				app: new URL(`http://127.0.0.1:${(appServer.address() as AddressInfo).port}`),
			},
			listenerMode: "http",
			upstreamPfx: null,
			crossOriginIsolation: true,
		};
		proxy = createDevProxyServer({ config, scheme: "http" });
		track(proxy);
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

	it("returns 502 with a Proxy error message when the upstream is unreachable", async () => {
		const closed = http.createServer();
		await listen(closed);
		const port = (closed.address() as AddressInfo).port;
		await new Promise<void>((resolve) => closed.close(() => resolve()));

		const unreachable = createDevProxyServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				targets: { api: new URL(`http://127.0.0.1:${port}`), app: TARGETS.app },
				listenerMode: "http",
				upstreamPfx: null,
				crossOriginIsolation: false,
			},
			scheme: "http",
		});
		await listen(unreachable);
		try {
			const response = await fetch(`http://127.0.0.1:${(unreachable.address() as AddressInfo).port}/1.0`);
			assert.equal(response.status, 502);
			assert.match(await response.text(), /^Proxy error: /);
		} finally {
			unreachable.closeAllConnections();
			unreachable.close();
		}
	});

	it("pipes websocket bytes both ways through the upgrade path", async () => {
		const proxyPort = Number(new URL(proxyBase).port);
		const client = net.connect(proxyPort, "127.0.0.1");
		await new Promise<void>((resolve) => client.once("connect", () => resolve()));
		client.write(
			"GET /1.0/events?type=lifecycle HTTP/1.1\r\nHost: localhost:3001\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: sid=2\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n",
		);

		let received_bytes = "";
		client.on("data", (chunk: Buffer) => {
			received_bytes += chunk.toString();
		});

		await waitFor(() => received_bytes.includes("\r\n\r\n"));
		assert.match(received_bytes, /^HTTP\/1\.1 101/);
		assert.equal(received.apiCookie, "sid=2");

		client.write("ping");
		await waitFor(() => received_bytes.endsWith("ping"));
		client.destroy();
	});
});

function listen(server: net.Server | http.Server): Promise<void> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

// Polls until the condition holds; fails the test after the deadline instead of hanging.
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
