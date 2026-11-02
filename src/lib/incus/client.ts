// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

export type IncusErrorKind =
	| "auth"
	| "forbidden"
	| "not-found"
	/** 412: the If-Match precondition no longer holds (the resource changed). */
	| "conflict"
	/** The connected deployment lacks the API extension a request needs (#7). */
	| "unsupported"
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

/** A background operation reference from a 202 "async" response. */
export interface IncusOperationRef {
	/** Operation id (last segment of the operation URL). */
	id: string;
	/** The operation object Incus returned with the acceptance. */
	metadata: unknown;
}

export interface IncusResponse<T> {
	status: number;
	/** `metadata` of a sync response. Undefined for async responses. */
	metadata: T;
	/** ETag of the representation, when the server sent one. */
	etag: string | null;
	/** Set when the server accepted the request as a background operation. */
	operation: IncusOperationRef | null;
}

export interface IncusFetchOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	query?: IncusQuery;
	/** Serialized as JSON. */
	body?: unknown;
	/** Sent as If-Match: the ETag of the writable baseline the change was built from. */
	ifMatch?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

/** Sends one Incus API request and decodes its envelope (sync or async). */
export async function incusFetch<T>(
	path: string,
	opts: IncusFetchOptions = {},
): Promise<IncusResponse<T>> {
	const { query, signal, fetchImpl = fetch, method = "GET" } = opts;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	if (opts.ifMatch !== undefined) headers["If-Match"] = opts.ifMatch;

	let response: Response;
	try {
		response = await fetchImpl(buildIncusUrl(path, query), {
			method,
			headers,
			credentials: "same-origin",
			signal,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		});
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
		throw httpError(response.status, body);
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

	const etag = response.headers?.get?.("ETag") ?? null;

	if (body.type === "async") {
		const operation = operationRef(body);
		if (!operation) {
			throw new IncusApiError(
				"malformed",
				`Async response without operation for ${path}`,
				{
					status: response.status,
				},
			);
		}
		return {
			status: response.status,
			metadata: undefined as T,
			etag,
			operation,
		};
	}

	if (body.type !== "sync") {
		throw new IncusApiError(
			"malformed",
			`Unsupported Incus envelope type "${body.type}"`,
			{
				status: response.status,
			},
		);
	}

	return {
		status: response.status,
		metadata: body.metadata as T,
		etag,
		operation: null,
	};
}

function operationRef(body: IncusEnvelope): IncusOperationRef | null {
	const url = (body as { operation?: unknown }).operation;
	const meta = isRecord(body.metadata) ? body.metadata : {};
	const fromUrl =
		typeof url === "string"
			? (url.split("?")[0]?.split("/").filter(Boolean).at(-1) ?? "")
			: "";
	const id = fromUrl || (typeof meta.id === "string" ? meta.id : "");
	return id ? { id, metadata: body.metadata } : null;
}

/** GETs an Incus API path and returns the envelope `metadata`. */
export async function incusRequest<T>(
	path: string,
	opts: {
		query?: IncusQuery;
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
	} = {},
): Promise<T> {
	const response = await incusFetch<T>(path, opts);
	if (response.operation) {
		throw new IncusApiError(
			"malformed",
			`Unexpected async response for ${path}`,
			{
				status: response.status,
			},
		);
	}
	return response.metadata;
}

function kindForStatus(status: number): IncusErrorKind {
	if (status === 401) return "auth";
	if (status === 403) return "forbidden";
	if (status === 404) return "not-found";
	if (status === 412) return "conflict";
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
