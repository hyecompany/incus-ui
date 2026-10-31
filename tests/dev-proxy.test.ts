// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { describe, it } from "node:test";

import {
	isAppPath,
	parseListenerMode,
	preferredPublicHost,
	resolveUpstreamUrl,
	rewriteLocationHeader,
	shouldUseHttpsListener,
	startDevProxy,
} from "../scripts/dev-proxy.ts";

describe("dev proxy routing", () => {
	it("sends /ui to the app and the Incus API elsewhere", () => {
		const app = new URL("http://127.0.0.1:5173");
		const api = new URL("https://localhost:8443");
		const ui = resolveUpstreamUrl(
			new URL("http://localhost:3000/ui/instances?x=1"),
			app,
			api,
		);
		const events = resolveUpstreamUrl(
			new URL("http://localhost:3000/1.0/events"),
			app,
			api,
		);

		assert.equal(ui.app, true);
		assert.equal(ui.url.href, "http://127.0.0.1:5173/ui/instances?x=1");
		assert.equal(events.app, false);
		assert.equal(events.url.href, "https://localhost:8443/1.0/events");
		assert.equal(isAppPath("/ui"), true);
		assert.equal(isAppPath("/1.0"), false);
	});

	it("rewrites upstream redirects and leaves external ones alone", () => {
		const upstream = new URL("https://localhost:8443/1.0");
		assert.equal(
			rewriteLocationHeader(
				"https://localhost:8443/1.0/instances",
				upstream,
				"https://127.0.0.1:3000",
				false,
			),
			"https://127.0.0.1:3000/1.0/instances",
		);
		assert.equal(
			rewriteLocationHeader(
				"https://issuer.example/auth",
				upstream,
				"https://127.0.0.1:3000",
				false,
			),
			undefined,
		);
		assert.equal(
			rewriteLocationHeader(
				"/login",
				new URL("http://127.0.0.1:5173/ui/"),
				"http://localhost:3000",
				true,
			),
			"http://localhost:3000/ui/login",
		);
	});

	it("uses HTTPS unless the listener is forced to HTTP or a client certificate is enabled", () => {
		assert.equal(shouldUseHttpsListener("auto", false), true);
		assert.equal(shouldUseHttpsListener("auto", true), false);
		assert.equal(shouldUseHttpsListener("http", false), false);
		assert.equal(shouldUseHttpsListener("https", true), true);
		assert.throws(() => parseListenerMode("tcp"), /DEV_PROXY_LISTENER_MODE/);
	});

	it("prefers the Incus certificate address that browsers can match", () => {
		assert.equal(preferredPublicHost(undefined), "localhost");
		if (existsSync("/var/lib/incus/server.crt")) {
			assert.equal(
				preferredPublicHost("/var/lib/incus/server.crt"),
				"127.0.0.1",
			);
		}
	});
});

describe("dev proxy server", () => {
	it("forwards HTTP and WebSocket traffic to the matching upstream", async () => {
		const seen: string[] = [];
		const acceptUpgrade = (
			req: IncomingMessage,
			socket: Duplex,
			label: string,
		) => {
			seen.push(`${label} ${req.url}`);
			const key = req.headers["sec-websocket-key"];
			const accept = createHash("sha1")
				.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
				.digest("base64");
			const requestedProtocol = req.headers["sec-websocket-protocol"];
			const protocolHeader =
				typeof requestedProtocol === "string"
					? `Sec-WebSocket-Protocol: ${requestedProtocol.split(",")[0]}\r\n`
					: "";
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
					`Sec-WebSocket-Accept: ${accept}\r\n${protocolHeader}\r\n`,
			);
			socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
		};
		let apiPort = 0;
		const api = createServer((req, res) => {
			seen.push(`api ${req.method} ${req.url}`);
			if (req.url === "/redirect") {
				res.writeHead(302, { location: `http://127.0.0.1:${apiPort}/1.0` });
				res.end();
				return;
			}
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				res.setHeader("x-upstream", "api");
				res.end(
					Buffer.concat(chunks).length > 0 ? Buffer.concat(chunks) : "api",
				);
			});
		});
		api.on("upgrade", (req, socket) => acceptUpgrade(req, socket, "api-ws"));
		const app = createServer((req, res) => {
			seen.push(`app ${req.url}`);
			res.setHeader("x-upstream", "app");
			res.end("app");
		});
		app.on("upgrade", (req, socket) => acceptUpgrade(req, socket, "app-ws"));

		await listen(api);
		await listen(app);
		const apiAddress = api.address();
		const appAddress = app.address();
		assert.ok(apiAddress && typeof apiAddress === "object");
		assert.ok(appAddress && typeof appAddress === "object");
		apiPort = apiAddress.port;

		const proxy = await startDevProxy({
			listenPort: 0,
			apiTarget: `http://127.0.0.1:${apiAddress.port}`,
			appTarget: `http://127.0.0.1:${appAddress.port}`,
			listenerMode: "http",
			upstreamClientPfxEnabled: false,
		});

		try {
			const apiResponse = await fetch(`${proxy.origin}/1.0/instances`, {
				method: "POST",
				body: "name=web-1",
			});
			assert.equal(apiResponse.headers.get("x-upstream"), "api");
			assert.equal(await apiResponse.text(), "name=web-1");

			const appResponse = await fetch(`${proxy.origin}/ui/instances`);
			assert.equal(appResponse.headers.get("x-upstream"), "app");
			assert.equal(await appResponse.text(), "app");

			const redirect = await fetch(`${proxy.origin}/redirect`, {
				redirect: "manual",
			});
			assert.equal(redirect.status, 302);
			assert.equal(redirect.headers.get("location"), `${proxy.origin}/1.0`);

			const apiSocket = new WebSocket(
				`${proxy.origin.replace("http", "ws")}/1.0/events`,
			);
			assert.equal(await nextMessage(apiSocket), "ok");
			apiSocket.close();

			const appSocket = new WebSocket(
				`${proxy.origin.replace("http", "ws")}/ui`,
				["vite-hmr"],
			);
			assert.equal(await nextMessage(appSocket), "ok");
			appSocket.close();

			assert.ok(seen.includes("api-ws /1.0/events"));
			assert.ok(seen.includes("app-ws /ui"));
		} finally {
			await proxy.close();
			api.close();
			app.close();
		}
	});
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
}

function nextMessage(socket: WebSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		socket.addEventListener("message", (event) => resolve(String(event.data)), {
			once: true,
		});
		socket.addEventListener(
			"error",
			() => reject(new Error("WebSocket failed")),
			{ once: true },
		);
	});
}
