/// <reference types="node" />
// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Development proxy for the Incus UI. Serves the Vite app (/ui) and the Incus API of the
 * remote selected in the Incus CLI from one origin. `npm run dev` runs it and also starts
 * the Vite dev server as a child process. See docs/contributing/development-proxy.md.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

export interface ProxyTargets {
	api: URL;
	app: URL;
}

/** How the proxy reaches the Incus API. Derived from the selected Incus CLI remote. */
export interface UpstreamOptions {
	/** Unix socket to use instead of the API URL (the `local` remote). */
	socketPath?: string;
	/** Client certificate and key for TLS client authentication (Incus CLI client.crt/client.key). */
	clientCert?: string;
	clientKey?: string;
	/** Pinned server certificate (Incus CLI servercerts/<remote>.crt). */
	serverCert?: string;
}

export interface ProxyConfig {
	host: string;
	port: number;
	targets: ProxyTargets;
	remote: string;
	upstream: UpstreamOptions;
	crossOriginIsolation: boolean;
	/** Problems worth showing at startup that do not stop the proxy. */
	warnings: string[];
}

export interface IncusRemote {
	addr: string;
	protocol?: string;
	authType?: string;
	public: boolean;
}

export interface IncusCliConfig {
	defaultRemote?: string;
	remotes: Record<string, IncusRemote>;
}

interface YamlMap {
	[key: string]: string | YamlMap;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3001;
const DEFAULT_APP_PORT = 5173;
const DEFAULT_REMOTE = "local";
const DEFAULT_SOCKET_PATH = "/var/lib/incus/unix.socket";
const LOCAL_API_URL = "http://localhost/";
const UNIX_PREFIX = "unix://";

/** Parses the nested `key: value` YAML that the Incus CLI writes. Lists and flow syntax are rejected. */
export function parseSimpleYaml(text: string): YamlMap {
	const root: YamlMap = {};
	const stack: Array<{ indent: number; map: YamlMap }> = [{ indent: -1, map: root }];

	text.split(/\r?\n/).forEach((raw, index) => {
		const content = raw.replace(/(^|\s)#.*$/, "");
		if (content.trim() === "") {
			return;
		}

		const indent = content.length - content.trimStart().length;
		const line = content.trim();
		if (line === "-" || line.startsWith("- ")) {
			throw new Error(`line ${index + 1}: YAML lists are not supported`);
		}

		const colon = line.indexOf(":");
		if (colon <= 0) {
			throw new Error(`line ${index + 1}: expected "key: value"`);
		}

		const key = unquote(line.slice(0, colon).trim());
		const value = line.slice(colon + 1).trim();
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}

		const parent = stack[stack.length - 1].map;
		if (value === "") {
			const child: YamlMap = {};
			parent[key] = child;
			stack.push({ indent, map: child });
		} else {
			parent[key] = unquote(value);
		}
	});

	return root;
}

function unquote(value: string): string {
	const first = value[0];
	if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
		return value.slice(1, -1);
	}
	return value;
}

function scalar(map: YamlMap, key: string): string | undefined {
	if (!Object.hasOwn(map, key)) {
		return undefined;
	}

	const value = map[key];
	if (typeof value !== "string") {
		throw new Error(`"${key}" must be a single value`);
	}
	return value;
}

export function parseIncusConfig(text: string): IncusCliConfig {
	const root = parseSimpleYaml(text);
	const rawRemotes = Object.hasOwn(root, "remotes") ? root.remotes : {};
	if (typeof rawRemotes === "string") {
		throw new Error(`"remotes" must be a mapping`);
	}

	const remotes: Record<string, IncusRemote> = {};
	for (const [name, entry] of Object.entries(rawRemotes)) {
		if (typeof entry === "string") {
			throw new Error(`remote "${name}" must be a mapping`);
		}

		const addr = scalar(entry, "addr");
		if (!addr) {
			throw new Error(`remote "${name}" has no addr`);
		}

		remotes[name] = {
			addr,
			protocol: scalar(entry, "protocol"),
			authType: scalar(entry, "auth_type"),
			public: scalar(entry, "public") === "true",
		};
	}

	return { defaultRemote: scalar(root, "default-remote"), remotes };
}

/** Incus CLI config directory: $INCUS_CONF, otherwise ~/.config/incus. */
export function incusConfigDir(env: Record<string, string | undefined>, home: string = homedir()): string {
	return env.INCUS_CONF || join(home, ".config", "incus");
}

/** Remote named by `--remote <name>` / `--remote=<name>`, if present. */
export function parseRemoteArg(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--remote") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("--remote requires a remote name, for example --remote local");
			}
			return value;
		}

		if (arg.startsWith("--remote=")) {
			const value = arg.slice("--remote=".length);
			if (!value) {
				throw new Error("--remote requires a remote name, for example --remote=local");
			}
			return value;
		}
	}
	return undefined;
}

/**
 * Picks the remote name: --remote, then INCUS_REMOTE, then the CLI default-remote, then `local`.
 * The built-in `local` remote is used even when config.yml does not list it.
 */
export function selectRemote(
	cli: IncusCliConfig,
	configPath: string,
	requested: string | undefined,
): { name: string; remote: IncusRemote } {
	const name = requested || cli.defaultRemote || DEFAULT_REMOTE;
	if (Object.hasOwn(cli.remotes, name)) {
		return { name, remote: cli.remotes[name] };
	}

	if (name === DEFAULT_REMOTE) {
		return { name, remote: { addr: UNIX_PREFIX, public: false } };
	}

	throw new Error(`Incus remote "${name}" is not configured in ${configPath}. Run "incus remote list" to see the configured remotes.`);
}

function unixSocketPath(addr: string, env: Record<string, string | undefined>): string {
	const explicit = addr.slice(UNIX_PREFIX.length);
	if (explicit) {
		return explicit;
	}
	if (env.INCUS_SOCKET) {
		return env.INCUS_SOCKET;
	}
	if (env.INCUS_DIR) {
		return join(env.INCUS_DIR, "unix.socket");
	}
	return DEFAULT_SOCKET_PATH;
}

function readOptional(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Turns a remote from the Incus CLI config into the API target and TLS material for the proxy. */
export function resolveUpstream(
	name: string,
	remote: IncusRemote,
	configDir: string,
	env: Record<string, string | undefined>,
): { api: URL; upstream: UpstreamOptions; warnings: string[] } {
	if (remote.protocol && remote.protocol !== "incus") {
		throw new Error(
			`Remote "${name}" uses protocol "${remote.protocol}". The dev proxy only supports "incus" remotes; simplestreams remotes are image servers, not the Incus API.`,
		);
	}

	if (remote.addr.startsWith(UNIX_PREFIX)) {
		return { api: new URL(LOCAL_API_URL), upstream: { socketPath: unixSocketPath(remote.addr, env) }, warnings: [] };
	}

	const addr = /^[a-z][a-z0-9+.-]*:\/\//i.test(remote.addr) ? remote.addr : `https://${remote.addr}`;
	const api = new URL(addr);
	if (api.protocol !== "https:" && api.protocol !== "http:") {
		throw new Error(`Remote "${name}" has an unsupported address ${remote.addr}. Expected https://, http:// or unix://.`);
	}

	const upstream: UpstreamOptions = {};
	const warnings: string[] = [];
	if (api.protocol === "https:") {
		upstream.serverCert = readOptional(join(configDir, "servercerts", `${name}.crt`));
	}

	if (remote.authType !== "oidc" && !remote.public) {
		const certPath = join(configDir, "client.crt");
		const keyPath = join(configDir, "client.key");
		if (existsSync(certPath) && existsSync(keyPath)) {
			upstream.clientCert = readFileSync(certPath, "utf8");
			upstream.clientKey = readFileSync(keyPath, "utf8");
		} else if (api.protocol === "https:") {
			warnings.push(
				`No TLS client certificate at ${certPath}. Run any incus command (for example "incus list") to generate one, and make sure the server trusts it.`,
			);
		}
	}

	return { api, upstream, warnings };
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value === "") {
		return fallback;
	}

	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid ${name} value ${value}. Expected 1-65535.`);
	}
	return port;
}

/** Reads the Incus CLI config and builds the proxy configuration. Reads only from the Incus config directory. */
export function parseConfig(env: Record<string, string | undefined>, args: string[] = []): ProxyConfig {
	const port = parsePort(env.DEV_PROXY_PORT, DEFAULT_PORT, "DEV_PROXY_PORT");
	const appPort = parsePort(env.DEV_PROXY_APP_PORT, DEFAULT_APP_PORT, "DEV_PROXY_APP_PORT");

	const configDir = incusConfigDir(env);
	const configPath = join(configDir, "config.yml");
	let cli: IncusCliConfig;
	try {
		cli = parseIncusConfig(readOptional(configPath) ?? "");
	} catch (error) {
		throw new Error(`Cannot read ${configPath}: ${error instanceof Error ? error.message : "unknown error"}`);
	}

	const requested = parseRemoteArg(args) ?? env.INCUS_REMOTE;
	const { name, remote } = selectRemote(cli, configPath, requested);
	const resolved = resolveUpstream(name, remote, configDir, env);

	return {
		host: env.DEV_PROXY_HOST || DEFAULT_HOST,
		port,
		targets: { api: resolved.api, app: new URL(`http://127.0.0.1:${appPort}`) },
		remote: name,
		upstream: resolved.upstream,
		crossOriginIsolation: env.DEV_PROXY_CROSS_ORIGIN_ISOLATION === "1",
		warnings: resolved.warnings,
	};
}

/** Human-readable summary of where API requests go. */
export function describeUpstream(config: ProxyConfig): string {
	if (config.upstream.socketPath) {
		return `unix socket ${config.upstream.socketPath}`;
	}

	const auth = config.upstream.clientCert ? "TLS client certificate" : "no client certificate";
	return `${config.targets.api.origin}, ${auth}`;
}

export function isApiPath(pathname: string): boolean {
	return !(pathname === "/ui" || pathname.startsWith("/ui/"));
}

/** Upstream URL for a request path (path and query kept). */
export function resolveTarget(requestPath: string, targets: ProxyTargets): { isApi: boolean; url: URL } {
	const parsed = new URL(requestPath, "http://proxy.invalid");
	const isApi = isApiPath(parsed.pathname);
	const base = isApi ? targets.api : targets.app;
	return { isApi, url: new URL(`${parsed.pathname}${parsed.search}`, base) };
}

/** Rewrites upstream Location headers onto the incoming origin. */
export function rewriteLocation(location: string, upstreamUrl: URL, incomingOrigin: string, isApi: boolean): string {
	let resolved: URL;
	try {
		resolved = new URL(location, upstreamUrl);
	} catch {
		return location;
	}

	if (resolved.protocol !== upstreamUrl.protocol || resolved.host !== upstreamUrl.host) {
		return location;
	}

	let redirectPath = `${resolved.pathname}${resolved.search}${resolved.hash}`;
	if (!isApi && isApiPath(redirectPath)) {
		redirectPath = `/ui${redirectPath}`;
	}

	return new URL(redirectPath, incomingOrigin).toString();
}

const API_UPGRADE_HEADERS = new Set(["cookie", "authorization", "user-agent", "upgrade", "connection"]);

/** API websockets forward an allowlist of headers; Vite HMR gets all but Host. */
export function filterUpgradeHeaders(
	headers: Record<string, string | string[] | undefined>,
	isApi: boolean,
): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (value === undefined || lower === "host") {
			continue;
		}

		if (isApi && !API_UPGRADE_HEADERS.has(lower) && !lower.startsWith("sec-websocket-")) {
			continue;
		}

		for (const item of Array.isArray(value) ? value : [value]) {
			pairs.push([name, item]);
		}
	}
	return pairs;
}

type TlsOptions = Pick<tls.ConnectionOptions, "cert" | "key" | "ca" | "checkServerIdentity">;

/** Client certificate for the API, and the pinned server certificate when one exists. */
function upstreamTlsOptions(upstream: UpstreamOptions): TlsOptions {
	const options: TlsOptions = {};
	if (upstream.clientCert && upstream.clientKey) {
		options.cert = upstream.clientCert;
		options.key = upstream.clientKey;
	}

	if (upstream.serverCert) {
		// Incus pins self-signed server certificates and trusts the pin regardless of hostname; match that.
		options.ca = upstream.serverCert;
		options.checkServerIdentity = () => undefined;
	}
	return options;
}

function crossOriginIsolationHeaders(): Record<string, string> {
	return {
		"Cross-Origin-Opener-Policy": "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Origin-Agent-Cluster": "?1",
	};
}

function handleHttpRequest(config: ProxyConfig, req: http.IncomingMessage, res: http.ServerResponse) {
	const { isApi, url: target } = resolveTarget(req.url ?? "/", config.targets);
	const transport = target.protocol === "https:" ? https : http;
	const headers = { ...req.headers, host: target.host };
	const options: https.RequestOptions = { method: req.method, headers };
	if (isApi) {
		Object.assign(options, upstreamTlsOptions(config.upstream));
		if (config.upstream.socketPath) {
			options.socketPath = config.upstream.socketPath;
		}
	}

	const upstreamReq = transport.request(target, options, (upstreamRes) => {
		const responseHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };

		if (!isApi && config.crossOriginIsolation) {
			Object.assign(responseHeaders, crossOriginIsolationHeaders());
		}

		const location = upstreamRes.headers.location;
		if (location) {
			const incomingOrigin = `http://${req.headers.host ?? `localhost:${config.port}`}`;
			responseHeaders.location = rewriteLocation(location, target, incomingOrigin, isApi);
		}

		res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders);
		upstreamRes.pipe(res);
	});

	upstreamReq.on("error", (error) => {
		if (res.headersSent) {
			res.destroy();
			return;
		}

		res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		res.end(`Proxy error: ${error.message}`);
	});

	res.on("close", () => {
		if (!res.writableFinished) {
			upstreamReq.destroy();
		}
	});

	req.pipe(upstreamReq);
}

function handleUpgrade(config: ProxyConfig, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
	const { isApi, url: target } = resolveTarget(req.url ?? "/", config.targets);
	const socketPath = isApi ? config.upstream.socketPath : undefined;
	const secure = !socketPath && target.protocol === "https:";
	const port = Number(target.port || (secure ? 443 : 80));
	const tlsOptions = isApi ? upstreamTlsOptions(config.upstream) : {};

	// Hold client data until the upstream is connected so nothing is emitted unobserved.
	socket.pause();

	let upstream: net.Socket;
	if (socketPath) {
		upstream = net.connect({ path: socketPath });
	} else if (secure) {
		upstream = tls.connect({
			...tlsOptions,
			host: target.hostname,
			port,
			servername: net.isIP(target.hostname) ? undefined : target.hostname,
		});
	} else {
		upstream = net.connect({ host: target.hostname, port });
	}

	const destroyBoth = () => {
		socket.destroy();
		upstream.destroy();
	};

	upstream.once(secure ? "secureConnect" : "connect", () => {
		const hostHeader = socketPath ? "localhost" : target.host;
		const headerLines = filterUpgradeHeaders(req.headers, isApi).map(([name, value]) => `${name}: ${value}\r\n`);
		upstream.write(`${req.method} ${req.url} HTTP/1.1\r\nHost: ${hostHeader}\r\n${headerLines.join("")}\r\n`);
		if (head.length > 0) {
			upstream.write(head);
		}

		socket.pipe(upstream);
		upstream.pipe(socket);
		socket.resume();
	});

	upstream.on("error", (error) => {
		if (!upstream.connecting && socket.writable) {
			socket.write(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nProxy error: ${error.message}`);
		}
		destroyBoth();
	});
	socket.on("error", destroyBoth);
	socket.on("close", () => upstream.destroy());
	upstream.on("close", () => socket.destroy());
}

/** Plain HTTP server that routes /ui to the Vite app and everything else to the Incus API. */
export function createDevProxyServer(config: ProxyConfig): http.Server {
	const server = http.createServer((req, res) => {
		try {
			handleHttpRequest(config, req, res);
		} catch (error) {
			res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(`Proxy error: ${error instanceof Error ? error.message : "unknown error"}`);
		}
	});

	server.on("upgrade", (req, socket, head) => {
		handleUpgrade(config, req, socket, head);
	});

	return server;
}

/** Command that starts the Vite dev server on the proxy's app target. */
export function viteCommand(appPort: number): { command: string; args: string[] } {
	const require = createRequire(import.meta.url);
	const viteBin = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
	return {
		command: process.execPath,
		args: [viteBin, "dev", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"],
	};
}

function main() {
	let config: ProxyConfig;
	try {
		config = parseConfig(process.env, process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}

	const server = createDevProxyServer(config);
	let vite: ChildProcess | undefined;
	let shuttingDown = false;
	const shutdown = (code: number) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		vite?.kill("SIGTERM");
		server.close();
		process.exit(code);
	};

	server.on("error", (error: NodeJS.ErrnoException) => {
		console.error(
			error.code === "EADDRINUSE"
				? `Port ${config.port} on ${config.host} is already in use. Stop the other process or set DEV_PROXY_PORT.`
				: `Dev proxy failed: ${error.message}`,
		);
		shutdown(1);
	});

	for (const warning of config.warnings) {
		console.warn(`Warning: ${warning}`);
	}

	server.listen(config.port, config.host, () => {
		console.log(`Incus remote: ${config.remote} (${describeUpstream(config)})`);
		console.log(`Open http://${config.host}:${config.port}/ui/ in your browser.`);
	});

	const { command, args } = viteCommand(Number(config.targets.app.port));
	vite = spawn(command, args, { stdio: "inherit", env: process.env });
	vite.on("error", (error) => {
		console.error(`Failed to start the Vite dev server: ${error.message}`);
		shutdown(1);
	});
	vite.on("exit", (code, signal) => {
		if (!shuttingDown) {
			console.error(`Vite dev server exited (${signal ?? `code ${code}`}). Stopping the dev proxy.`);
			shutdown(code ?? 1);
		}
	});

	process.on("SIGINT", () => shutdown(130));
	process.on("SIGTERM", () => shutdown(143));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
