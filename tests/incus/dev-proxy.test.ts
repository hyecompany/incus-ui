// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	createDevProxyServer,
	filterUpgradeHeaders,
	incusConfigDir,
	isApiPath,
	parseConfig,
	parseIncusConfig,
	parseRemoteArg,
	parseSimpleYaml,
	type ProxyConfig,
	resolveTarget,
	resolveUpstream,
	rewriteLocation,
	selectRemote,
	viteCommand,
} from "../../scripts/incus-dev-proxy.ts";

const TARGETS = {
	api: new URL("https://localhost:8443"),
	app: new URL("http://127.0.0.1:5173"),
};

const tempDirs: string[] = [];

/** Creates a temp Incus config directory with the given files (relative paths). Never touches ~/.config/incus. */
function makeConfigDir(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "incus-dev-proxy-"));
	tempDirs.push(dir);
	for (const [relative, content] of Object.entries(files)) {
		const full = join(dir, relative);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

after(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const CLI_CONFIG = `
# Incus CLI configuration
default-remote: work
remotes:
    images:
        addr: https://images.linuxcontainers.org
        protocol: simplestreams
        public: true
    local:
        addr: unix://
        public: false
    work:
        addr: 10.0.0.5:8443
        auth_type: tls
        project: default
        protocol: incus
        public: false
    cloud:
        addr: "https://incus.example:8443"
        auth_type: oidc
        protocol: incus
        public: false
    lab:
        addr: https://lab.example:8443
        protocol: incus
        public: true
    old:
        addr: https://old.example:8443
        protocol: simplestreams
        public: true
`;

describe("parseSimpleYaml", () => {
	it("parses nested mappings, comments and quoted scalars", () => {
		const parsed = parseSimpleYaml(`
# comment
top: value # trailing comment
quoted: "https://x:8443"
outer:
    inner:
        leaf: 'single'
    sibling: 1
after: done
`);
		assert.deepEqual(parsed, {
			top: "value",
			quoted: "https://x:8443",
			outer: { inner: { leaf: "single" }, sibling: "1" },
			after: "done",
		});
	});

	it("rejects lists and lines without a key", () => {
		assert.throws(() => parseSimpleYaml("items:\n    - one"), /lists are not supported/);
		assert.throws(() => parseSimpleYaml("not a mapping"), /expected "key: value"/);
	});
});

describe("parseIncusConfig", () => {
	it("reads the default remote and the remote map", () => {
		const cli = parseIncusConfig(CLI_CONFIG);
		assert.equal(cli.defaultRemote, "work");
		assert.deepEqual(cli.remotes.work, { addr: "10.0.0.5:8443", authType: "tls", protocol: "incus", public: false });
		assert.equal(cli.remotes.images.public, true);
		assert.equal(cli.remotes.cloud.addr, "https://incus.example:8443");
	});

	it("treats an empty file as no remotes", () => {
		assert.deepEqual(parseIncusConfig(""), { defaultRemote: undefined, remotes: {} });
	});

	it("rejects a remote without an address", () => {
		assert.throws(() => parseIncusConfig("remotes:\n    broken:\n        protocol: incus\n"), /remote "broken" has no addr/);
	});
});

describe("selectRemote and parseRemoteArg", () => {
	const cli = parseIncusConfig(CLI_CONFIG);

	it("uses the CLI default remote unless one is requested", () => {
		assert.equal(selectRemote(cli, "cfg", undefined).name, "work");
		assert.equal(selectRemote(cli, "cfg", "lab").name, "lab");
	});

	it("falls back to the built-in local remote", () => {
		const bare = parseIncusConfig("");
		assert.deepEqual(selectRemote(bare, "cfg", undefined), { name: "local", remote: { addr: "unix://", public: false } });
	});

	it("names the config file when a remote is missing", () => {
		assert.throws(() => selectRemote(cli, "/x/config.yml", "nope"), /remote "nope" is not configured in \/x\/config.yml/);
	});

	it("does not treat inherited object keys as remotes", () => {
		assert.throws(() => selectRemote(cli, "cfg", "constructor"), /is not configured/);
	});

	it("parses --remote in both forms and rejects a missing value", () => {
		assert.equal(parseRemoteArg(["--remote", "lab"]), "lab");
		assert.equal(parseRemoteArg(["--remote=lab"]), "lab");
		assert.equal(parseRemoteArg([]), undefined);
		assert.throws(() => parseRemoteArg(["--remote"]), /requires a remote name/);
		assert.throws(() => parseRemoteArg(["--remote", "--other"]), /requires a remote name/);
	});
});

describe("resolveUpstream", () => {
	const dir = makeConfigDir({
		"client.crt": "CERT",
		"client.key": "KEY",
		"servercerts/work.crt": "PINNED",
	});

	it("maps a unix socket remote to the default socket path", () => {
		const resolved = resolveUpstream("local", { addr: "unix://", public: false }, dir, {});
		assert.equal(resolved.upstream.socketPath, "/var/lib/incus/unix.socket");
		assert.equal(resolved.api.href, "http://localhost/");
	});

	it("honours INCUS_SOCKET and INCUS_DIR for the local socket", () => {
		const local = { addr: "unix://", public: false };
		assert.equal(resolveUpstream("local", local, dir, { INCUS_SOCKET: "/tmp/a.sock" }).upstream.socketPath, "/tmp/a.sock");
		assert.equal(resolveUpstream("local", local, dir, { INCUS_DIR: "/srv/incus" }).upstream.socketPath, "/srv/incus/unix.socket");
		assert.equal(resolveUpstream("local", { addr: "unix:///run/x.sock", public: false }, dir, {}).upstream.socketPath, "/run/x.sock");
	});

	it("loads the client certificate and the pinned server certificate for TLS remotes", () => {
		const resolved = resolveUpstream("work", { addr: "10.0.0.5:8443", authType: "tls", public: false }, dir, {});
		assert.equal(resolved.api.href, "https://10.0.0.5:8443/");
		assert.deepEqual(resolved.upstream, { clientCert: "CERT", clientKey: "KEY", serverCert: "PINNED" });
		assert.deepEqual(resolved.warnings, []);
	});

	it("does not send a client certificate to OIDC or public remotes", () => {
		const oidc = resolveUpstream("cloud", { addr: "https://incus.example:8443", authType: "oidc", public: false }, dir, {});
		assert.equal(oidc.upstream.clientCert, undefined);
		const pub = resolveUpstream("lab", { addr: "https://lab.example:8443", public: true }, dir, {});
		assert.equal(pub.upstream.clientCert, undefined);
	});

	it("warns when a TLS remote has no client certificate", () => {
		const empty = makeConfigDir();
		const resolved = resolveUpstream("work", { addr: "https://10.0.0.5:8443", public: false }, empty, {});
		assert.equal(resolved.upstream.clientCert, undefined);
		assert.equal(resolved.warnings.length, 1);
		assert.match(resolved.warnings[0], /No TLS client certificate/);
	});

	it("rejects simplestreams remotes with a clear error", () => {
		assert.throws(
			() => resolveUpstream("images", { addr: "https://images.linuxcontainers.org", protocol: "simplestreams", public: true }, dir, {}),
			/uses protocol "simplestreams"/,
		);
	});
});

describe("parseConfig", () => {
	it("reads the Incus CLI config from INCUS_CONF and uses the default remote", () => {
		const dir = makeConfigDir({ "config.yml": CLI_CONFIG, "client.crt": "C", "client.key": "K" });
		const config = parseConfig({ INCUS_CONF: dir });
		assert.equal(config.remote, "work");
		assert.equal(config.host, "127.0.0.1");
		assert.equal(config.port, 3001);
		assert.equal(config.targets.api.href, "https://10.0.0.5:8443/");
		assert.equal(config.targets.app.href, "http://127.0.0.1:5173/");
		assert.equal(config.upstream.clientCert, "C");
		assert.equal(config.crossOriginIsolation, false);
		assert.deepEqual(config.warnings, []);
	});

	it("falls back to the local socket when there is no Incus config", () => {
		const config = parseConfig({ INCUS_CONF: makeConfigDir() });
		assert.equal(config.remote, "local");
		assert.equal(config.upstream.socketPath, "/var/lib/incus/unix.socket");
	});

	it("selects the remote from INCUS_REMOTE and --remote, with --remote winning", () => {
		const dir = makeConfigDir({ "config.yml": CLI_CONFIG });
		assert.equal(parseConfig({ INCUS_CONF: dir, INCUS_REMOTE: "lab" }).remote, "lab");
		assert.equal(parseConfig({ INCUS_CONF: dir, INCUS_REMOTE: "lab" }, ["--remote", "cloud"]).remote, "cloud");
	});

	it("uses the local socket for a unix remote", () => {
		const dir = makeConfigDir({ "config.yml": CLI_CONFIG });
		const config = parseConfig({ INCUS_CONF: dir, INCUS_REMOTE: "local", INCUS_SOCKET: "/tmp/i.sock" });
		assert.equal(config.upstream.socketPath, "/tmp/i.sock");
	});

	it("fails clearly for an unknown remote", () => {
		const dir = makeConfigDir({ "config.yml": CLI_CONFIG });
		assert.throws(() => parseConfig({ INCUS_CONF: dir, INCUS_REMOTE: "missing" }), /Incus remote "missing" is not configured/);
	});

	it("reports an unreadable config file by path", () => {
		const dir = makeConfigDir({ "config.yml": "remotes: [a, b]\n" });
		assert.throws(() => parseConfig({ INCUS_CONF: dir }), /Cannot read .*config\.yml/);
	});

	it("reads the listen host and the crossOriginIsolation flag", () => {
		const dir = makeConfigDir();
		const config = parseConfig({ INCUS_CONF: dir, DEV_PROXY_HOST: "10.1.1.240", DEV_PROXY_CROSS_ORIGIN_ISOLATION: "1" });
		assert.equal(config.host, "10.1.1.240");
		assert.equal(config.crossOriginIsolation, true);
	});

	it("reads the app port used for the spawned Vite server", () => {
		const config = parseConfig({ INCUS_CONF: makeConfigDir(), DEV_PROXY_APP_PORT: "5180" });
		assert.equal(config.targets.app.href, "http://127.0.0.1:5180/");
	});

	it("rejects an invalid port", () => {
		const dir = makeConfigDir();
		assert.throws(() => parseConfig({ INCUS_CONF: dir, DEV_PROXY_PORT: "70000" }), /Invalid DEV_PROXY_PORT/);
		assert.throws(() => parseConfig({ INCUS_CONF: dir, DEV_PROXY_APP_PORT: "0" }), /Invalid DEV_PROXY_APP_PORT/);
	});

	it("uses INCUS_CONF or ~/.config/incus for the config directory", () => {
		assert.equal(incusConfigDir({ INCUS_CONF: "/x/incus" }, "/home/u"), "/x/incus");
		assert.equal(incusConfigDir({}, "/home/u"), "/home/u/.config/incus");
	});
});

describe("viteCommand", () => {
	it("runs the installed Vite on the requested port without a fixed host name", () => {
		const { command, args } = viteCommand(5173);
		assert.equal(command, process.execPath);
		assert.ok(existsSync(args[0]), `expected Vite entry at ${args[0]}`);
		assert.deepEqual(args.slice(1), ["dev", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
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

describe("websocket headers", () => {
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
			remote: "test",
			upstream: {},
			crossOriginIsolation: true,
			warnings: [],
		};
		proxy = createDevProxyServer(config);
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

		const server = createDevProxyServer({
			port: 0,
			host: "127.0.0.1",
			targets: { api: new URL(`http://127.0.0.1:${port}`), app: TARGETS.app },
			remote: "test",
			upstream: {},
			crossOriginIsolation: false,
			warnings: [],
		});
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

describe("proxy forwarding to a unix socket (local remote)", { timeout: 15000 }, () => {
	let socketServer: http.Server;
	let proxy: http.Server;
	let proxyPort: number;
	const socketPath = join(makeConfigDir(), "unix.socket");

	before(async () => {
		socketServer = http.createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json", "x-host": req.headers.host ?? "" });
			res.end(JSON.stringify({ path: req.url }));
		});
		await new Promise<void>((resolve) => socketServer.listen(socketPath, () => resolve()));

		proxy = createDevProxyServer({
			port: 0,
			host: "127.0.0.1",
			targets: { api: new URL("http://localhost/"), app: TARGETS.app },
			remote: "local",
			upstream: { socketPath },
			crossOriginIsolation: false,
			warnings: [],
		});
		await listen(proxy);
		proxyPort = (proxy.address() as AddressInfo).port;
	});

	after(() => {
		proxy.closeAllConnections();
		proxy.close();
		socketServer.close();
	});

	it("forwards API requests over the socket", async () => {
		const response = await fetch(`http://127.0.0.1:${proxyPort}/1.0?x=1`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { path: "/1.0?x=1" });
		assert.equal(response.headers.get("x-host"), "localhost");
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
