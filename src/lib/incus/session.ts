// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IncusApiError, incusRequest } from "./client.ts";

export interface IncusSession {
	trusted: boolean;
	/**
	 * Identifies the authenticated session on this deployment:
	 * `<deploymentId>/<method>:<user>`. Null when not trusted.
	 */
	sessionKey: string | null;
	/** The server's certificate fingerprint (or name). Null when not trusted. */
	deploymentId: string | null;
}

const UNTRUSTED: IncusSession = {
	trusted: false,
	sessionKey: null,
	deploymentId: null,
};

function readString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the session from `GET /1.0` metadata. Identity fields that are missing
 * fall back to "unknown", so two trusted sessions are never confused with
 * each other by accident.
 */
export function parseSession(metadata: unknown): IncusSession {
	if (!isRecord(metadata) || metadata.auth !== "trusted") {
		return UNTRUSTED;
	}
	const method =
		readString(metadata, "auth_user_method") ??
		readString(metadata, "auth_method") ??
		"unknown";
	const user = readString(metadata, "auth_user_name") ?? "unknown";
	const environment = isRecord(metadata.environment)
		? metadata.environment
		: {};
	const deploymentId =
		readString(environment, "certificate_fingerprint") ??
		readString(environment, "server_name") ??
		"unknown";
	return {
		trusted: true,
		sessionKey: `${deploymentId}/${method}:${user}`,
		deploymentId,
	};
}

/**
 * Fetches the current session. Auth and forbidden responses map to untrusted.
 * Other failures are rethrown so the caller can decide what to show.
 */
export async function fetchSession(opts?: {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<IncusSession> {
	try {
		const metadata = await incusRequest<unknown>("/1.0", opts);
		return parseSession(metadata);
	} catch (error) {
		if (
			error instanceof IncusApiError &&
			(error.kind === "auth" || error.kind === "forbidden")
		) {
			return UNTRUSTED;
		}
		throw error;
	}
}

export type SessionState =
	| { status: "loading" }
	| { status: "ready"; session: IncusSession }
	| { status: "error"; error: IncusApiError };

export interface SessionStore {
	get(): SessionState;
	subscribe(listener: () => void): () => void;
	/** Re-reads GET /1.0 (e.g. after login or logout). */
	refresh(): Promise<void>;
	dispose(): void;
}

/**
 * Holds the current session. Transient failures (network, server) are retried
 * a bounded number of times; anything else is reported as an error state.
 */
export function createSessionStore(
	opts: {
		fetchImpl?: typeof fetch;
		retryDelaysMs?: readonly number[];
		setTimeout?: (callback: () => void, ms: number) => unknown;
	} = {},
): SessionStore {
	const retryDelays = opts.retryDelaysMs ?? [1_000, 3_000, 10_000];
	const setTimer =
		opts.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
	const listeners = new Set<() => void>();
	let state: SessionState = { status: "loading" };
	let generation = 0;
	let disposed = false;

	const publish = (next: SessionState) => {
		state = next;
		for (const listener of [...listeners]) listener();
	};

	const load = async (attempt: number, run: number): Promise<void> => {
		try {
			const session = await fetchSession({ fetchImpl: opts.fetchImpl });
			if (!disposed && run === generation)
				publish({ status: "ready", session });
		} catch (cause) {
			if (disposed || run !== generation) return;
			const error =
				cause instanceof IncusApiError
					? cause
					: new IncusApiError("network", "Could not read the session", {
							cause,
						});
			const delay = retryDelays[attempt];
			if (
				(error.kind === "network" || error.kind === "server") &&
				delay !== undefined
			) {
				await new Promise<void>((resolve) => setTimer(resolve, delay));
				return load(attempt + 1, run);
			}
			publish({ status: "error", error });
		}
	};

	void load(0, generation);

	return {
		get: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refresh() {
			generation += 1;
			return load(0, generation);
		},
		dispose() {
			disposed = true;
			listeners.clear();
		},
	};
}
