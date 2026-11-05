// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	describeUpstream,
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
		assert.equal(
			resolveUpstream("local", local, dir, { INCUS_DIR: "/srv/incus" }).upstream.socketPath,
			join("/srv/incus", "unix.socket"),
		);
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
		assert.equal(resolved.warnings.length, 2);
		assert.match(resolved.warnings.join("\n"), /No pinned server certificate/);
		assert.match(resolved.warnings.join("\n"), /No TLS client certificate/);
	});

	it("warns when an HTTPS remote has no pinned server certificate", () => {
		const certsOnly = makeConfigDir({ "client.crt": "CERT", "client.key": "KEY" });
		const pinPath = join(certsOnly, "servercerts", "work.crt");
		const resolved = resolveUpstream("work", { addr: "https://10.0.0.5:8443", public: false }, certsOnly, {});
		assert.equal(resolved.upstream.clientCert, "CERT");
		assert.equal(resolved.upstream.serverCert, undefined);
		assert.equal(resolved.warnings.length, 1);
		assert.match(resolved.warnings[0], /No pinned server certificate/);
		assert.ok(resolved.warnings[0].includes(pinPath));
	});

	it("does not warn about a missing server pin for http remotes", () => {
		const empty = makeConfigDir();
		const resolved = resolveUpstream("plain", { addr: "http://10.0.0.5:8080", public: false }, empty, {});
		assert.equal(resolved.upstream.serverCert, undefined);
		assert.deepEqual(resolved.warnings, []);
	});

	it("rejects simplestreams remotes with a clear error", () => {
		assert.throws(
			() => resolveUpstream("images", { addr: "https://images.linuxcontainers.org", protocol: "simplestreams", public: true }, dir, {}),
			/uses protocol "simplestreams"/,
		);
	});

	it("rejects unsupported address schemes", () => {
		assert.throws(
			() => resolveUpstream("bad", { addr: "ftp://example", public: false }, dir, {}),
			/unsupported address/,
		);
	});
});

describe("parseConfig", () => {
	it("reads the Incus CLI config from INCUS_CONF and uses the default remote", () => {
		const dir = makeConfigDir({
			"config.yml": CLI_CONFIG,
			"client.crt": "C",
			"client.key": "K",
			"servercerts/work.crt": "PIN",
		});
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
		assert.equal(incusConfigDir({}, "/home/u"), join("/home/u", ".config", "incus"));
	});
});

describe("describeUpstream", () => {
	it("reports a unix socket path", () => {
		const config: ProxyConfig = {
			host: "127.0.0.1",
			port: 3001,
			targets: TARGETS,
			remote: "local",
			upstream: { socketPath: "/var/lib/incus/unix.socket" },
			crossOriginIsolation: false,
			warnings: [],
		};
		assert.equal(describeUpstream(config), "unix socket /var/lib/incus/unix.socket");
	});

	it("reports the API origin and whether a client certificate is present", () => {
		const withCert: ProxyConfig = {
			host: "127.0.0.1",
			port: 3001,
			targets: TARGETS,
			remote: "work",
			upstream: { clientCert: "C", clientKey: "K" },
			crossOriginIsolation: false,
			warnings: [],
		};
		assert.equal(describeUpstream(withCert), "https://localhost:8443, TLS client certificate");
		assert.equal(describeUpstream({ ...withCert, upstream: {} }), "https://localhost:8443, no client certificate");
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
