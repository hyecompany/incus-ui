/// <reference types="node" />
// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/** Development proxy that serves the Vite app (/ui) and the Incus API from one origin. */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

export type ListenerMode = "auto" | "http" | "https";

export interface ProxyTargets {
	api: URL;
	app: URL;
}

export interface UpstreamPfx {
	path: string;
	passphrase: string;
}

export interface ProxyConfig {
	host: string;
	port: number;
	targets: ProxyTargets;
	listenerMode: ListenerMode;
	upstreamPfx: UpstreamPfx | null;
	crossOriginIsolation: boolean;
}

const TLS_CERT_PATH = "./server.crt";
const TLS_KEY_PATH = "./server.key";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3001;
const DEFAULT_API_TARGET = "https://localhost:8443";
const DEFAULT_APP_TARGET = "http://127.0.0.1:5173";
const DEFAULT_UPSTREAM_PFX_PATH = "./ararat.pfx";

export function parseListenerMode(value: string | undefined): ListenerMode {
	if (!value) {
		return "auto";
	}

	const normalized = value.toLowerCase();
	if (normalized === "auto" || normalized === "http" || normalized === "https") {
		return normalized;
	}

	throw new Error(`Invalid DEV_PROXY_LISTENER_MODE value ${value}. Expected auto, http, or https.`);
}

export function shouldUseHttpsListener(mode: ListenerMode, upstreamPfxEnabled: boolean): boolean {
	if (mode === "https") {
		return true;
	}

	if (mode === "http") {
		return false;
	}

	return !upstreamPfxEnabled;
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

/** Only the local self-signed dev API is trusted without verification. */
export function allowsSelfSignedUpstream(url: URL): boolean {
	return url.protocol === "https:" && url.hostname === "localhost" && url.port === "8443";
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

export function parseConfig(env: Record<string, string | undefined>): ProxyConfig {
	const port = Number(env.DEV_PROXY_PORT ?? DEFAULT_PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid DEV_PROXY_PORT value ${env.DEV_PROXY_PORT}. Expected 1-65535.`);
	}

	const upstreamPfxEnabled = env.DEV_PROXY_UPSTREAM_CLIENT_PFX === "1";

	return {
		host: env.DEV_PROXY_HOST || DEFAULT_HOST,
		port,
		targets: {
			api: new URL(env.DEV_PROXY_API_TARGET ?? DEFAULT_API_TARGET),
			app: new URL(env.DEV_PROXY_APP_TARGET ?? DEFAULT_APP_TARGET),
		},
		listenerMode: parseListenerMode(env.DEV_PROXY_LISTENER_MODE),
		upstreamPfx: upstreamPfxEnabled
			? {
					path: env.DEV_PROXY_UPSTREAM_CLIENT_PFX_PATH ?? DEFAULT_UPSTREAM_PFX_PATH,
					passphrase: env.DEV_PROXY_UPSTREAM_CLIENT_PFX_PASSPHRASE ?? "",
				}
			: null,
		crossOriginIsolation: env.DEV_PROXY_CROSS_ORIGIN_ISOLATION === "1",
	};
}

interface ProxyContext {
	config: ProxyConfig;
	scheme: "http" | "https";
	pfx: Buffer | null;
}

function tlsOptionsFor(ctx: ProxyContext, url: URL, isApi: boolean): tls.ConnectionOptions {
	const options: tls.ConnectionOptions = {};
	if (allowsSelfSignedUpstream(url)) {
		options.rejectUnauthorized = false;
	}

	if (isApi && url.protocol === "https:" && ctx.config.upstreamPfx && ctx.pfx) {
		options.pfx = ctx.pfx;
		options.passphrase = ctx.config.upstreamPfx.passphrase;
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

function handleHttpRequest(ctx: ProxyContext, req: http.IncomingMessage, res: http.ServerResponse) {
	const { isApi, url: target } = resolveTarget(req.url ?? "/", ctx.config.targets);
	const transport = target.protocol === "https:" ? https : http;
	const headers = { ...req.headers, host: target.host };

	const upstreamReq = transport.request(target, { method: req.method, headers, ...tlsOptionsFor(ctx, target, isApi) }, (upstreamRes) => {
		const responseHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };

		if (!isApi && ctx.config.crossOriginIsolation) {
			Object.assign(responseHeaders, crossOriginIsolationHeaders());
		}

		const location = upstreamRes.headers.location;
		if (location) {
			const incomingOrigin = `${ctx.scheme}://${req.headers.host ?? `localhost:${ctx.config.port}`}`;
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

function handleUpgrade(ctx: ProxyContext, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
	const { isApi, url: target } = resolveTarget(req.url ?? "/", ctx.config.targets);
	const secure = target.protocol === "https:" || target.protocol === "wss:";
	const port = Number(target.port || (secure ? 443 : 80));
	const connectOptions = { host: target.hostname, port, ...tlsOptionsFor(ctx, target, isApi) };

	// Hold client data until the upstream is connected so nothing is emitted unobserved.
	socket.pause();

	const upstream: net.Socket = secure
		? tls.connect({ ...connectOptions, servername: net.isIP(target.hostname) ? undefined : target.hostname })
		: net.connect(connectOptions);

	const destroyBoth = () => {
		socket.destroy();
		upstream.destroy();
	};

	upstream.once(secure ? "secureConnect" : "connect", () => {
		const headerLines = filterUpgradeHeaders(req.headers, isApi).map(([name, value]) => `${name}: ${value}\r\n`);
		upstream.write(`${req.method} ${req.url} HTTP/1.1\r\nHost: ${target.host}\r\n${headerLines.join("")}\r\n`);
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

export function createDevProxyServer(ctx: { config: ProxyConfig; scheme: "http" | "https"; tlsOptions?: https.ServerOptions; pfx?: Buffer | null }) {
	const proxyCtx: ProxyContext = { config: ctx.config, scheme: ctx.scheme, pfx: ctx.pfx ?? null };
	const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
		try {
			handleHttpRequest(proxyCtx, req, res);
		} catch (error) {
			res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(`Proxy error: ${error instanceof Error ? error.message : "unknown error"}`);
		}
	};

	const server = ctx.tlsOptions
		? https.createServer(ctx.tlsOptions, onRequest)
		: http.createServer(onRequest);

	server.on("upgrade", (req, socket, head) => {
		handleUpgrade(proxyCtx, req, socket, head);
	});

	return server;
}

function main() {
	let config: ProxyConfig;
	try {
		config = parseConfig(process.env);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}

	const useHttps = shouldUseHttpsListener(config.listenerMode, config.upstreamPfx !== null);
	let tlsOptions: https.ServerOptions | undefined;
	if (useHttps) {
		if (!existsSync(TLS_CERT_PATH) || !existsSync(TLS_KEY_PATH)) {
			console.error(
				`TLS certificate or key not found at ${TLS_CERT_PATH} and ${TLS_KEY_PATH}. Please copy /var/lib/incus/server.crt and /var/lib/server.key from your Incus host to these paths, or set DEV_PROXY_LISTENER_MODE=http.`,
			);
			process.exit(1);
		}
		tlsOptions = { cert: readFileSync(TLS_CERT_PATH), key: readFileSync(TLS_KEY_PATH) };
	}

	let pfx: Buffer | null = null;
	if (config.upstreamPfx) {
		const { path, passphrase } = config.upstreamPfx;
		if (!existsSync(path)) {
			console.error(`DEV_PROXY_UPSTREAM_CLIENT_PFX=1 but PFX file was not found at ${path}`);
			process.exit(1);
		}
		pfx = readFileSync(path);
		try {
			// Validates the passphrase and container up front; the error text never includes the passphrase.
			tls.createSecureContext({ pfx, passphrase });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown error";
			console.error(`Failed to load upstream client PFX at ${path}. Set DEV_PROXY_UPSTREAM_CLIENT_PFX_PASSPHRASE if needed. Details: ${message}`);
			process.exit(1);
		}
	}

	const scheme = useHttps ? "https" : "http";
	const server = createDevProxyServer({ config, scheme, tlsOptions, pfx });
	server.on("error", (error: NodeJS.ErrnoException) => {
		console.error(
			error.code === "EADDRINUSE"
				? `Port ${config.port} on ${config.host} is already in use. Stop the other process or set DEV_PROXY_PORT.`
				: `Dev proxy failed: ${error.message}`,
		);
		process.exit(1);
	});
	server.listen(config.port, config.host, () => {
		console.log(`Incus Host: ${config.targets.api.origin}`);
		console.log(`App dev server: ${config.targets.app.origin}`);
		console.log(
			`Incus UI dev proxy listening on ${scheme}://${config.host}:${config.port} (listener mode: ${config.listenerMode}${config.upstreamPfx ? ", upstream TLS client auth enabled" : ""})`,
		);
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
