// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

export type IncusErrorKind =
	| "auth"
	| "forbidden"
	| "not-found"
	| "malformed"
	| "network"
	| "server"
	| "aborted";

export class IncusApiError extends Error {
	status: number;
	code: number;
	kind: IncusErrorKind;

	constructor(
		kind: IncusErrorKind,
		message: string,
		options: { status?: number; code?: number; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "IncusApiError";
		this.kind = kind;
		this.status = options.status ?? 0;
		this.code = options.code ?? 0;
	}
}

export type IncusQuery = Record<string, string | undefined>;

interface IncusEnvelope {
	type: string;
	status_code?: number;
	error_code?: number;
	error?: string;
	metadata: unknown;
}

// Placeholder origin used only to parse relative paths; never requested.
const URL_BASE = "http://incus.invalid";

/** Builds a same-origin request path. */
export function buildIncusUrl(path: string, query?: IncusQuery): string {
	// Reject protocol-relative paths so a request can never leave the origin.
	if (!path.startsWith("/") || path.startsWith("//")) {
		throw new Error(`Incus path must be an absolute same-origin path: ${path}`);
	}

	const url = new URL(path, URL_BASE);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) {
			url.searchParams.set(key, value);
		}
	}

	return `${url.pathname}${url.search}`;
}

export type IncusMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type AuthFailureListener = (error: IncusApiError, path: string) => void;
const authFailureListeners = new Set<AuthFailureListener>();

/** Called when a request is refused with 401/403 (session may have ended). */
export function onAuthFailure(listener: AuthFailureListener): () => void {
	authFailureListeners.add(listener);
	return () => {
		authFailureListeners.delete(listener);
	};
}

/** Sends a request to an Incus API path and returns the envelope `metadata`. */
export async function incusRequest<T>(
	path: string,
	opts: {
		method?: IncusMethod;
		query?: IncusQuery;
		/** JSON request body. */
		body?: unknown;
		headers?: Record<string, string>;
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
	} = {},
): Promise<T> {
	const { query, signal, fetchImpl = fetch, method = "GET" } = opts;
	const headers: Record<string, string> = {
		Accept: "application/json",
		...opts.headers,
	};
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	const send = () =>
		fetchImpl(buildIncusUrl(path, query), {
			method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			credentials: "same-origin",
			signal,
		});

	let response: Response;
	try {
		response = await send();
		// `incus webui` answers 305 after refreshing an expired OIDC token.
		if (response.status === 305) response = await send();
	} catch (cause) {
		throw transportError(cause);
	}

	let text: string;
	try {
		text = await response.text();
	} catch (cause) {
		throw transportError(cause);
	}

	const body = parseJson(text);

	if (!response.ok) {
		const error = httpError(response.status, body);
		if (error.kind === "auth" || error.kind === "forbidden") {
			for (const listener of [...authFailureListeners]) listener(error, path);
		}
		throw error;
	}

	if (!isEnvelope(body)) {
		throw new IncusApiError(
			"malformed",
			`Unexpected Incus response for ${path}`,
			{
				status: response.status,
			},
		);
	}

	if (body.type === "error") {
		throw httpError(body.status_code ?? response.status, body);
	}

	if (body.type !== "sync" && body.type !== "async") {
		throw new IncusApiError(
			"malformed",
			`Unsupported Incus envelope type "${body.type}"`,
			{
				status: response.status,
			},
		);
	}

	return body.metadata as T;
}

function kindForStatus(status: number): IncusErrorKind {
	if (status === 401) return "auth";
	if (status === 403) return "forbidden";
	if (status === 404) return "not-found";
	if (status === 400) return "malformed";
	return "server";
}

function httpError(status: number, body: unknown): IncusApiError {
	const envelope = isRecord(body) ? body : {};
	const message =
		typeof envelope.error === "string" && envelope.error !== ""
			? envelope.error
			: `HTTP ${status}`;
	const code =
		typeof envelope.error_code === "number" ? envelope.error_code : 0;

	return new IncusApiError(kindForStatus(status), message, { status, code });
}

function transportError(cause: unknown): IncusApiError {
	if (isAbortError(cause)) {
		return new IncusApiError("aborted", "Request was aborted", { cause });
	}

	return new IncusApiError("network", "Could not reach the Incus API", {
		cause,
	});
}

function isAbortError(cause: unknown): boolean {
	return isRecord(cause) && cause.name === "AbortError";
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isEnvelope(value: unknown): value is IncusEnvelope {
	return (
		isRecord(value) && typeof value.type === "string" && "metadata" in value
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
