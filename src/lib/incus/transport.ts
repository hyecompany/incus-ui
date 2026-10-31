// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { recordApiSample } from "./timings.ts";

export class IncusRequestError extends Error {
	readonly status: number;
	readonly errorCode: number;

	constructor(message: string, status: number, errorCode: number) {
		super(message);
		this.name = "IncusRequestError";
		this.status = status;
		this.errorCode = errorCode;
	}
}

export type IncusResult<T> = {
	type: "sync" | "async";
	metadata: T;
	etag: string | null;
	operation: string;
	location: string | null;
	statusCode: number;
};

export type IncusRequest = {
	method?: string;
	body?: unknown;
	signal?: AbortSignal;
	headers?: HeadersInit;
};

export function incusPath(
	path: string,
	query?: Record<string, string | undefined>,
): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) params.set(key, value);
	}
	const search = params.toString();
	return search ? `${path}?${search}` : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function incusRequest<T>(
	path: string,
	init: IncusRequest = {},
): Promise<IncusResult<T>> {
	const started = performance.now();
	const method = init.method ?? "GET";
	let status = 0;
	let bytes = 0;
	let ok = false;
	try {
		return await readIncusResponse<T>(path, init, method, (next) => {
			status = next.status;
			bytes = next.bytes;
			ok = next.ok;
		});
	} finally {
		recordApiSample({
			method,
			path,
			durationMs: performance.now() - started,
			status,
			bytes,
			ok,
		});
	}
}

async function readIncusResponse<T>(
	path: string,
	init: IncusRequest,
	method: string,
	observe: (sample: { status: number; bytes: number; ok: boolean }) => void,
): Promise<IncusResult<T>> {
	const headers = new Headers(init.headers);
	if (init.body !== undefined) headers.set("content-type", "application/json");

	const response = await fetch(path, {
		method,
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: init.signal,
	});
	const text = await response.text();
	const bytes = new TextEncoder().encode(text).byteLength;
	observe({ status: response.status, bytes, ok: false });
	let payload: unknown = null;
	if (text) {
		try {
			payload = JSON.parse(text) as unknown;
		} catch {
			throw new IncusRequestError(
				response.statusText || "Incus returned a non-JSON response",
				response.status,
				response.status,
			);
		}
	}

	if (
		!isRecord(payload) ||
		(payload.type !== "sync" &&
			payload.type !== "async" &&
			payload.type !== "error")
	) {
		throw new IncusRequestError(
			response.statusText || "Incus returned an unexpected response",
			response.status,
			response.status,
		);
	}

	if (payload.type === "error" || !response.ok) {
		const message =
			typeof payload.error === "string" && payload.error
				? payload.error
				: response.statusText || "Incus request failed";
		const errorCode =
			typeof payload.error_code === "number"
				? payload.error_code
				: response.status;
		throw new IncusRequestError(message, response.status, errorCode);
	}

	observe({ status: response.status, bytes, ok: true });
	return {
		type: payload.type,
		metadata: payload.metadata as T,
		etag: response.headers.get("etag"),
		operation: typeof payload.operation === "string" ? payload.operation : "",
		location: response.headers.get("location"),
		statusCode:
			typeof payload.status_code === "number"
				? payload.status_code
				: response.status,
	};
}
