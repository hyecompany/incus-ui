// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { AuthStorage } from "../auth-storage.ts";
import type { SessionState } from "../session.ts";

export interface TokenClaims {
	exp?: number;
	nbf?: number;
	sub?: string;
}

export type TokenLoginResult =
	| { ok: true; exp: number | null }
	| {
			ok: false;
			reason:
				| "expired"
				| "invalid"
				| "malformed"
				| "unsupported"
				| "insecure"
				| "network"
				| "other";
			/** The token's `exp` (seconds), when it could be decoded. */
			exp: number | null;
			/** Server error text for "other"; never contains the token. */
			message?: string;
	  };

type FetchOpts = { fetchImpl?: typeof fetch; signal?: AbortSignal };

/** Removes whitespace and an accidental "Bearer " prefix from a pasted token. */
export function normalizeToken(input: string): string {
	return input.replace(/^\s*bearer\s+/i, "").replace(/\s+/g, "");
}

function decodeSegment(segment: string): unknown {
	const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder().decode(bytes));
}

/** Reads the JWT payload without verifying it (the server does that). */
export function decodeTokenClaims(token: string): TokenClaims | null {
	const parts = normalizeToken(token).split(".");
	if (parts.length !== 3 || parts.some((part) => part === "")) return null;
	let payload: unknown;
	try {
		payload = decodeSegment(parts[1]);
	} catch {
		return null;
	}
	if (typeof payload !== "object" || payload === null) return null;
	const raw = payload as Record<string, unknown>;
	const claims: TokenClaims = {};
	if (typeof raw.exp === "number" && Number.isFinite(raw.exp)) {
		claims.exp = raw.exp;
	}
	if (typeof raw.nbf === "number" && Number.isFinite(raw.nbf)) {
		claims.nbf = raw.nbf;
	}
	if (typeof raw.sub === "string") claims.sub = raw.sub;
	return claims;
}

/** Whether the server has `/tls/login` (Incus 7.6+, `auth_tls_jwt_cookie`). */
export async function supportsTokenLogin(
	opts: FetchOpts = {},
): Promise<boolean> {
	const { fetchImpl = fetch, signal } = opts;
	// GET is refused with 405 by servers that have the endpoint.
	const response = await fetchImpl("/tls/login", {
		method: "GET",
		credentials: "same-origin",
		signal,
	});
	if (response.status === 405) return true;
	if (response.status === 404) return false;
	throw new Error(
		`Could not tell whether this server supports client tokens (GET /tls/login answered ${response.status}).`,
	);
}

async function errorText(response: Response): Promise<string> {
	try {
		const body: unknown = JSON.parse(await response.text());
		if (typeof body === "object" && body !== null && "error" in body) {
			const { error } = body as { error: unknown };
			if (typeof error === "string") return error;
		}
	} catch {
		// Not an Incus error envelope.
	}
	return response.statusText;
}

/** Exchanges a certificate-signed JWT for the server's `tls_jwt` cookie. */
export async function loginWithToken(
	token: string,
	opts: FetchOpts & { now?: () => number } = {},
): Promise<TokenLoginResult> {
	const { fetchImpl = fetch, signal, now = Date.now } = opts;
	const jwt = normalizeToken(token);
	const claims = decodeTokenClaims(jwt);
	const exp = claims?.exp ?? null;
	if (!claims) return { ok: false, reason: "malformed", exp };
	if (exp !== null && exp * 1000 <= now()) {
		return { ok: false, reason: "expired", exp };
	}

	let response: Response;
	try {
		response = await fetchImpl("/tls/login", {
			method: "POST",
			headers: { Authorization: `Bearer ${jwt}` },
			credentials: "same-origin",
			signal,
		});
	} catch (cause) {
		if (signal?.aborted) throw cause;
		return { ok: false, reason: "network", exp };
	}

	if (response.ok) return { ok: true, exp };
	const message = await errorText(response);
	if (response.status === 404) return { ok: false, reason: "unsupported", exp };
	if (response.status === 403 && /invalid token/i.test(message)) {
		return { ok: false, reason: "invalid", exp };
	}
	if (response.status === 400) {
		return /tls connection/i.test(message)
			? { ok: false, reason: "insecure", exp }
			: { ok: false, reason: "malformed", exp };
	}
	return { ok: false, reason: "other", exp, message };
}

/** Clears the `tls_jwt` cookie. Safe to call when signed in another way. */
export async function logoutToken(opts: FetchOpts = {}): Promise<void> {
	const { fetchImpl = fetch, signal } = opts;
	const response = await fetchImpl("/tls/logout", {
		method: "POST",
		credentials: "same-origin",
		signal,
	});
	if (!response.ok && response.status !== 404) {
		throw new Error(
			`Signing out of the client token failed (${response.status}).`,
		);
	}
}

export type TokenFailure = Extract<TokenLoginResult, { ok: false }>;

/** Plain-language explanation of a failed token sign-in. */
export function describeTokenFailure(
	failure: TokenFailure,
	formatTime: (exp: number) => string,
): { title: string; detail: string } {
	switch (failure.reason) {
		case "expired":
			return {
				title: "This token has expired",
				detail: `It stopped working at ${failure.exp === null ? "an earlier time" : formatTime(failure.exp)}. Run the command again to get a new token and paste it here.`,
			};
		case "invalid":
			return {
				title: "The server did not accept this token",
				detail:
					"Tokens only work when they are created by an Incus CLI whose certificate this server already trusts. Run the command on a computer where `incus` can already manage this server using its default client certificate (not one added with --tls-cert), and make sure the token is not expired or valid only in the future (check that both clocks are correct).",
			};
		case "malformed":
			return {
				title: "This does not look like a client token",
				detail:
					"Paste the whole line printed by `incus remote get-client-token`. It is one long string made of three parts separated by dots.",
			};
		case "unsupported":
			return {
				title: "This server does not support client tokens",
				detail:
					"Signing in with a client token needs Incus 7.6 or newer. Use another sign-in method, or ask the administrator to upgrade Incus.",
			};
		case "insecure":
			return {
				title: "Client tokens need a secure connection",
				detail:
					"The server only accepts tokens over HTTPS. Open this page with an https:// address and try again.",
			};
		case "network":
			return {
				title: "Could not reach the server",
				detail: "Check your network connection and try again.",
			};
		case "other":
			return {
				title: "Sign-in failed",
				detail: failure.message
					? `The server answered: ${failure.message}`
					: "The server refused the sign-in. Try again, or use another sign-in method.",
			};
	}
}

/** Why a token session ended: past `exp` means expiry, otherwise revocation or logout. */
export function tokenSessionEnd(
	exp: number | null,
	now: number = Date.now(),
): { kind: "expired"; exp: number } | { kind: "rejected" } {
	return exp !== null && exp * 1000 <= now
		? { kind: "expired", exp }
		: { kind: "rejected" };
}

type TokenHints = Pick<
	AuthStorage,
	"setLastMethod" | "setTokenExp" | "setResume"
>;

/** Remembers a token sign-in (method and `exp` only) so a lost session can be explained. */
export function rememberTokenSignIn(storage: TokenHints, exp: number | null) {
	storage.setLastMethod("tls-token");
	storage.setTokenExp(exp);
	storage.setResume(null);
}

/** Drops the token hints, e.g. when the user picks another sign-in method. */
export function forgetTokenSignIn(storage: TokenHints) {
	storage.setLastMethod(null);
	storage.setTokenExp(null);
}

/** Whether to offer pasting a new token: the server says untrusted after a token sign-in. */
export function shouldOfferNewToken(
	state: SessionState,
	lastMethod: string | null,
): boolean {
	return (
		lastMethod === "tls-token" &&
		state.status === "ready" &&
		!state.session.trusted
	);
}
