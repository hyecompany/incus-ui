// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

/**
 * Development proxy that serves Incus UI the way incusd does in production.
 *
 * The browser talks to this process. Paths under /ui go to the Vite dev
 * server. Every other path, including Incus HTTP APIs and WebSocket upgrades
 * (events, operations, consoles), goes to the Incus daemon.
 *
 *   DEV_PROXY_API_TARGET                 Incus base URL (default https://localhost:8443)
 *   DEV_PROXY_APP_TARGET                 Vite base URL (default http://127.0.0.1:5173)
 *   DEV_PROXY_APP_PORT                   Vite port when this process starts Vite
 *   DEV_PROXY_PORT                       Public port (default 3000)
 *   DEV_PROXY_HOST                       Listen address (default 0.0.0.0)
 *   DEV_PROXY_PUBLIC_HOST                Host advertised to browsers and Vite
 *   DEV_PROXY_LISTENER_MODE              auto, http, or https (default auto)
 *   DEV_PROXY_TLS_CERT                   HTTPS listener certificate
 *   DEV_PROXY_TLS_KEY                    HTTPS listener private key
 *   DEV_PROXY_UPSTREAM_CLIENT_PFX        Set to 1 to present a client certificate to Incus
 *   DEV_PROXY_UPSTREAM_CLIENT_PFX_PATH   PKCS#12 path (default ./client.pfx)
 *   DEV_PROXY_UPSTREAM_CLIENT_PFX_PASSPHRASE
 *   DEV_PROXY_SPAWN_APP                  Set to 0 to skip launching Vite
 *
 * auto uses HTTPS unless upstream client-certificate auth is enabled, because
 * OIDC in the browser depends on HTTPS. Certificates are read from
 * ./server.crt and ./server.key, then from /var/lib/incus/server.crt and
 * /var/lib/incus/server.key. Set DEV_PROXY_LISTENER_MODE=http to skip TLS.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type RequestOptions,
	type ServerResponse,
} from "node:http";
import {
	createServer as createHttpsServer,
	Agent as HttpsAgent,
	request as httpsRequest,
} from "node:https";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { createSecureContext } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ListenerMode = "auto" | "http" | "https";

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

export type DevProxyOptions = {
	listenPort: number;
	apiTarget: string;
	appTarget: string;
	listenerMode: ListenerMode;
	upstreamClientPfxEnabled: boolean;
	upstreamClientPfxPath?: string;
	upstreamClientPfxPassphrase?: string;
	tlsCertPath?: string;
	tlsKeyPath?: string;
	listenHost?: string;
	publicHost?: string;
};

export type RunningDevProxy = {
	port: number;
	origin: string;
	close: () => Promise<void>;
};

type UpstreamSelection = {
	url: URL;
	app: boolean;
};

export function parseListenerMode(value: string | undefined): ListenerMode {
	if (!value) return "auto";
	const normalized = value.toLowerCase();
	if (normalized === "auto" || normalized === "http" || normalized === "https")
		return normalized;
	throw new Error(
		`Invalid DEV_PROXY_LISTENER_MODE value ${value}. Expected auto, http, or https.`,
	);
}

export function shouldUseHttpsListener(
	mode: ListenerMode,
	upstreamClientPfxEnabled: boolean,
): boolean {
	if (mode === "https") return true;
	if (mode === "http") return false;
	return !upstreamClientPfxEnabled;
}

export function isAppPath(pathname: string): boolean {
	return pathname === "/ui" || pathname.startsWith("/ui/");
}

export function parseTargetUrl(
	value: string,
	defaultProtocol: "http:" | "https:",
): URL {
	const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
	return new URL(hasProtocol ? value : `${defaultProtocol}//${value}`);
}

export function resolveUpstreamUrl(
	incoming: URL,
	appTarget: URL,
	apiTarget: URL,
): UpstreamSelection {
	const app = isAppPath(incoming.pathname);
	const base = app ? appTarget : apiTarget;
	return {
		app,
		url: new URL(`${incoming.pathname}${incoming.search}`, base),
	};
}

export function rewriteLocationHeader(
	location: string,
	upstream: URL,
	incomingOrigin: string,
	app: boolean,
): string | undefined {
	let resolved: URL;
	try {
		resolved = new URL(location, upstream);
	} catch {
		return undefined;
	}
	if (resolved.host !== upstream.host) return undefined;

	let path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
	if (app && path !== "/ui" && !path.startsWith("/ui/")) {
		path = `/ui${path.startsWith("/") ? path : `/${path}`}`;
	}
	return new URL(path, incomingOrigin).toString();
}

export function resolveTlsPair(
	certPath: string | undefined,
	keyPath: string | undefined,
): { certPath: string; keyPath: string } | undefined {
	if (certPath || keyPath) {
		if (!certPath || !keyPath) {
			throw new Error("Set both DEV_PROXY_TLS_CERT and DEV_PROXY_TLS_KEY.");
		}
		if (!existsSync(certPath) || !existsSync(keyPath)) {
			throw new Error(
				`TLS certificate or key not found at ${certPath} and ${keyPath}.`,
			);
		}
		return { certPath, keyPath };
	}

	const candidates = [
		{ certPath: "server.crt", keyPath: "server.key" },
		{
			certPath: "/var/lib/incus/server.crt",
			keyPath: "/var/lib/incus/server.key",
		},
	];
	for (const candidate of candidates) {
		if (existsSync(candidate.certPath) && existsSync(candidate.keyPath))
			return candidate;
	}
	return undefined;
}

export function preferredPublicHost(certPath: string | undefined): string {
	if (!certPath) return "localhost";
	try {
		const certificate = new X509Certificate(readFileSync(certPath));
		const entries = (certificate.subjectAltName ?? "")
			.split(",")
			.map((entry) => entry.trim());
		if (entries.includes("DNS:localhost")) return "localhost";
		if (
			entries.includes("IP Address:127.0.0.1") ||
			entries.includes("IP:127.0.0.1")
		)
			return "127.0.0.1";
		const dnsName = entries.find((entry) => entry.startsWith("DNS:"));
		if (dnsName) return dnsName.slice("DNS:".length);
	} catch {
		return "localhost";
	}
	return "localhost";
}

function headerValues(value: string | string[] | undefined): string[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

function connectionHeaderNames(headers: IncomingHttpHeaders): Set<string> {
	return new Set(
		headerValues(headers.connection)
			.join(",")
			.split(",")
			.map((part) => part.trim().toLowerCase())
			.filter(Boolean),
	);
}

function forwardedHeaders(
	headers: IncomingHttpHeaders,
	listenerScheme: "http" | "https",
	remoteAddress: string | undefined,
): Record<string, string | string[]> {
	const listed = connectionHeaderNames(headers);
	const outgoing: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower) || listed.has(lower)) continue;
		outgoing[name] = value;
	}

	const host = headerValues(headers.host)[0];
	if (host) outgoing.host = host;
	outgoing["x-forwarded-proto"] = listenerScheme;
	if (host) outgoing["x-forwarded-host"] = host;
	if (remoteAddress) {
		const existing = headerValues(headers["x-forwarded-for"]);
		outgoing["x-forwarded-for"] =
			existing.length > 0
				? `${existing.join(", ")}, ${remoteAddress}`
				: remoteAddress;
	}
	return outgoing;
}

function missingTlsMessage(): string {
	return [
		"TLS certificate or key not found at ./server.crt and ./server.key.",
		"Copy /var/lib/incus/server.crt and /var/lib/incus/server.key to those paths,",
		"set DEV_PROXY_TLS_CERT and DEV_PROXY_TLS_KEY, or set DEV_PROXY_LISTENER_MODE=http.",
		"HTTP mode can proxy the API. OIDC in the browser needs the HTTPS listener.",
	].join(" ");
}

export async function startDevProxy(
	options: DevProxyOptions,
): Promise<RunningDevProxy> {
	const useHttps = shouldUseHttpsListener(
		options.listenerMode,
		options.upstreamClientPfxEnabled,
	);
	const tls = useHttps
		? resolveTlsPair(options.tlsCertPath, options.tlsKeyPath)
		: undefined;
	if (useHttps && !tls) throw new Error(missingTlsMessage());

	const apiTarget = parseTargetUrl(options.apiTarget, "https:");
	const appTarget = parseTargetUrl(options.appTarget, "http:");
	const listenerScheme: "http" | "https" = useHttps ? "https" : "http";

	let pfx: Buffer | undefined;
	if (options.upstreamClientPfxEnabled) {
		const pfxPath = options.upstreamClientPfxPath ?? "./client.pfx";
		if (!existsSync(pfxPath)) {
			throw new Error(
				`DEV_PROXY_UPSTREAM_CLIENT_PFX=1 but PFX file was not found at ${pfxPath}`,
			);
		}
		pfx = readFileSync(pfxPath);
		try {
			createSecureContext({
				pfx,
				passphrase: options.upstreamClientPfxPassphrase,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to read upstream client PFX at ${pfxPath}. If it is password-protected, set DEV_PROXY_UPSTREAM_CLIENT_PFX_PASSPHRASE. ${message}`,
			);
		}
	}

	const apiAgent =
		apiTarget.protocol === "https:"
			? new HttpsAgent({
					keepAlive: true,
					rejectUnauthorized: false,
					pfx,
					passphrase: pfx ? options.upstreamClientPfxPassphrase : undefined,
				})
			: undefined;

	const sockets = new Set<Duplex>();

	const proxyHttp = (req: IncomingMessage, res: ServerResponse) => {
		const incomingHost = headerValues(req.headers.host)[0] ?? "localhost";
		const incomingUrl = new URL(
			req.url ?? "/",
			`${listenerScheme}://${incomingHost}`,
		);
		const upstream = resolveUpstreamUrl(incomingUrl, appTarget, apiTarget);
		const headers = forwardedHeaders(
			req.headers,
			listenerScheme,
			req.socket.remoteAddress,
		);
		const requestOptions: RequestOptions = {
			protocol: upstream.url.protocol,
			hostname: upstream.url.hostname,
			port: upstream.url.port,
			method: req.method,
			path: `${upstream.url.pathname}${upstream.url.search}`,
			headers,
			agent: upstream.app ? undefined : apiAgent,
		};
		const transport =
			upstream.url.protocol === "https:" ? httpsRequest : httpRequest;
		const proxyReq = transport(requestOptions, (proxyRes) => {
			const responseHeaders: Record<string, string | string[]> = {};
			for (const [name, value] of Object.entries(proxyRes.headers)) {
				if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
				responseHeaders[name] = value;
			}
			const location = headerValues(proxyRes.headers.location)[0];
			if (location) {
				const rewritten = rewriteLocationHeader(
					location,
					upstream.url,
					`${listenerScheme}://${incomingHost}`,
					upstream.app,
				);
				if (rewritten) responseHeaders.location = rewritten;
			}
			const status = proxyRes.statusCode ?? 502;
			if (proxyRes.statusMessage)
				res.writeHead(status, proxyRes.statusMessage, responseHeaders);
			else res.writeHead(status, responseHeaders);
			proxyRes.pipe(res);
		});
		proxyReq.on("error", (error) => {
			if (res.headersSent || res.writableEnded) {
				res.destroy();
				return;
			}
			const message =
				error instanceof Error ? error.message : "unknown upstream error";
			res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(`Proxy error: ${message}`);
		});
		res.on("close", () => {
			if (!res.writableFinished) proxyReq.destroy();
		});
		if (req.method === "GET" || req.method === "HEAD") proxyReq.end();
		else req.pipe(proxyReq);
	};

	const proxyUpgrade = (
		req: IncomingMessage,
		clientSocket: Duplex,
		head: Buffer,
	) => {
		const incomingHost = headerValues(req.headers.host)[0] ?? "localhost";
		const incomingUrl = new URL(
			req.url ?? "/",
			`${listenerScheme}://${incomingHost}`,
		);
		const protocol = headerValues(req.headers["sec-websocket-protocol"]).join(
			", ",
		);
		const app =
			isAppPath(incomingUrl.pathname) ||
			protocol
				.split(",")
				.some(
					(name) => name.trim() === "vite-hmr" || name.trim() === "vite-ping",
				);
		const base = app ? appTarget : apiTarget;
		const headers = forwardedHeaders(
			req.headers,
			listenerScheme,
			req.socket.remoteAddress,
		);
		headers.connection = "Upgrade";
		headers.upgrade = req.headers.upgrade ?? "websocket";
		const requestOptions: RequestOptions = {
			protocol: base.protocol,
			hostname: base.hostname,
			port: base.port,
			method: req.method ?? "GET",
			path: `${incomingUrl.pathname}${incomingUrl.search}`,
			headers,
			agent: app ? undefined : apiAgent,
		};
		const transport = base.protocol === "https:" ? httpsRequest : httpRequest;
		const proxyReq = transport(requestOptions);
		let upgraded = false;
		const fail = (error: unknown) => {
			const message =
				error instanceof Error ? error.message : "unknown upstream error";
			if (clientSocket.writable) {
				const body = `Proxy error: ${message}`;
				clientSocket.write(
					`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
				);
			}
			clientSocket.destroy();
			proxyReq.destroy();
		};
		proxyReq.on("upgrade", (proxyRes, upstreamSocket, upstreamHead) => {
			upgraded = true;
			// Browsers require these exact handshake header values. Forwarding the
			// upstream hop-by-hop headers is not a valid WebSocket response.
			const lines = [
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
			];
			const handshakeHeaders = [
				["sec-websocket-accept", "Sec-WebSocket-Accept"],
				["sec-websocket-protocol", "Sec-WebSocket-Protocol"],
				["sec-websocket-extensions", "Sec-WebSocket-Extensions"],
			] as const;
			for (const [source, name] of handshakeHeaders) {
				const value = headerValues(proxyRes.headers[source])[0];
				if (value) lines.push(`${name}: ${value}`);
			}
			clientSocket.write(`${lines.join("\r\n")}\r\n\r\n`, () => {
				if (clientSocket.destroyed || upstreamSocket.destroyed) return;
				if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
				if (head.length > 0) upstreamSocket.write(head);
				upstreamSocket.pipe(clientSocket);
				clientSocket.pipe(upstreamSocket);
			});
			upstreamSocket.on("error", () => clientSocket.destroy());
			clientSocket.on("error", () => upstreamSocket.destroy());
		});
		proxyReq.on("response", (proxyRes) => {
			const chunks: Buffer[] = [];
			proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
			proxyRes.on("end", () => {
				const body = Buffer.concat(chunks);
				const lines = [
					`HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? "Bad Gateway"}`,
				];
				for (const [name, value] of Object.entries(proxyRes.headers)) {
					if (name.toLowerCase() === "transfer-encoding") continue;
					for (const item of headerValues(value))
						lines.push(`${name}: ${item}`);
				}
				if (!proxyRes.headers["content-length"])
					lines.push(`content-length: ${body.length}`);
				lines.push("connection: close");
				clientSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
				clientSocket.end(body);
			});
		});
		proxyReq.on("error", fail);
		clientSocket.on("error", () => {
			if (!upgraded) proxyReq.destroy();
		});
		proxyReq.end();
	};

	const server: HttpServer = useHttps
		? createHttpsServer(
				{
					cert: readFileSync(tls?.certPath ?? ""),
					key: readFileSync(tls?.keyPath ?? ""),
				},
				proxyHttp,
			)
		: createHttpServer(proxyHttp);
	server.on("upgrade", proxyUpgrade);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.requestTimeout = 0;
	server.headersTimeout = 0;

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(options.listenPort, options.listenHost ?? "127.0.0.1");
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Dev proxy failed to bind a port");
	}

	const publicHost =
		options.publicHost ??
		(useHttps ? preferredPublicHost(tls?.certPath) : "127.0.0.1");
	const origin = `${listenerScheme}://${publicHost}:${address.port}`;

	return {
		port: address.port,
		origin,
		close: () =>
			new Promise<void>((resolve, reject) => {
				apiAgent?.destroy();
				for (const socket of sockets) socket.destroy();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

function primaryIPv4(): string | undefined {
	try {
		const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n");
		const iface = routes
			.slice(1)
			.map((line) => line.trim().split(/\s+/))
			.find((columns) => columns[1] === "00000000")?.[0];
		if (!iface) return undefined;
		return networkInterfaces()[iface]?.find(
			(entry) => entry.family === "IPv4" && !entry.internal,
		)?.address;
	} catch {
		return undefined;
	}
}

function isDirectRun(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return import.meta.url === pathToFileURL(entry).href;
}

function main() {
	const listenerMode = parseListenerMode(process.env.DEV_PROXY_LISTENER_MODE);
	const upstreamClientPfxEnabled =
		process.env.DEV_PROXY_UPSTREAM_CLIENT_PFX === "1";
	const useHttps = shouldUseHttpsListener(
		listenerMode,
		upstreamClientPfxEnabled,
	);
	const tls = useHttps
		? resolveTlsPair(
				process.env.DEV_PROXY_TLS_CERT,
				process.env.DEV_PROXY_TLS_KEY,
			)
		: undefined;
	if (useHttps && !tls) {
		console.error(missingTlsMessage());
		process.exit(1);
	}

	const listenPort = Number(process.env.DEV_PROXY_PORT ?? 3000);
	const listenHost = process.env.DEV_PROXY_HOST ?? "0.0.0.0";
	const appPort = process.env.DEV_PROXY_APP_PORT ?? "5173";
	const apiTarget =
		process.env.DEV_PROXY_API_TARGET ?? "https://localhost:8443";
	const appTarget =
		process.env.DEV_PROXY_APP_TARGET ?? `http://127.0.0.1:${appPort}`;
	const publicHost =
		process.env.DEV_PROXY_PUBLIC_HOST ??
		(listenHost === "0.0.0.0" || listenHost === "::"
			? (primaryIPv4() ?? "127.0.0.1")
			: listenHost);
	const scheme = useHttps ? "https" : "http";
	const spawnApp =
		process.env.DEV_PROXY_SPAWN_APP === "1" ||
		(process.env.DEV_PROXY_SPAWN_APP !== "0" &&
			!process.env.DEV_PROXY_APP_TARGET);

	let vite: ChildProcess | undefined;
	let proxy: RunningDevProxy | undefined;
	let shuttingDown = false;

	const shutdown = (exitCode: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (vite && !vite.killed) vite.kill("SIGTERM");
		void proxy?.close().finally(() => process.exit(exitCode));
	};

	process.on("SIGINT", () => shutdown(0));
	process.on("SIGTERM", () => shutdown(0));

	void startDevProxy({
		listenPort,
		listenHost,
		publicHost,
		apiTarget,
		appTarget,
		listenerMode,
		upstreamClientPfxEnabled,
		upstreamClientPfxPath: process.env.DEV_PROXY_UPSTREAM_CLIENT_PFX_PATH,
		upstreamClientPfxPassphrase:
			process.env.DEV_PROXY_UPSTREAM_CLIENT_PFX_PASSPHRASE,
		tlsCertPath: tls?.certPath,
		tlsKeyPath: tls?.keyPath,
	})
		.then((running) => {
			proxy = running;
			console.log(`Incus host: ${apiTarget}`);
			console.log(`Incus UI dev proxy listening on ${running.origin}/ui`);
			if (
				useHttps &&
				publicHost !== "127.0.0.1" &&
				publicHost !== "localhost"
			) {
				console.log(
					`The TLS certificate is for dev-server and 127.0.0.1, so https://${publicHost}:${running.port}/ui will show a browser warning.`,
				);
			}
			if (upstreamClientPfxEnabled) {
				console.log(
					`Upstream TLS client authentication enabled using ${process.env.DEV_PROXY_UPSTREAM_CLIENT_PFX_PATH ?? "./client.pfx"}`,
				);
			}
			if (!useHttps && upstreamClientPfxEnabled) {
				console.log(
					"HTTP listener is active because upstream TLS client authentication is enabled. Set DEV_PROXY_LISTENER_MODE=https for OIDC browser behavior.",
				);
			}
			if (!spawnApp) return;

			const viteEntry = fileURLToPath(
				new URL("../node_modules/vite/bin/vite.js", import.meta.url),
			);
			vite = spawn(
				process.execPath,
				[viteEntry, "--host", "127.0.0.1", "--clearScreen", "false"],
				{
					stdio: "inherit",
					env: {
						...process.env,
						DEV_PROXY_PUBLIC_ORIGIN: `${scheme}://${publicHost}:${running.port}`,
						DEV_PROXY_PORT: String(running.port),
						DEV_PROXY_APP_PORT: appPort,
						DEV_PROXY_HMR_PROTOCOL: scheme === "https" ? "wss" : "ws",
					},
				},
			);
			vite.on("exit", (code) => {
				if (!shuttingDown) {
					console.error(`Vite exited (${code ?? "signal"})`);
					shutdown(code ?? 1);
				}
			});
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		});
}

if (isDirectRun()) main();
