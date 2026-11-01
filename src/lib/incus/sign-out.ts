// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { AuthMethodUsed, AuthStorage } from "./auth-storage.ts";
import type { IncusApiError } from "./client.ts";
import type { IncusSession, SessionState } from "./session.ts";

export type SignOutResult =
	| { kind: "signed-out"; session: IncusSession }
	/** The browser still presents a trusted client certificate. */
	| { kind: "certificate"; session: IncusSession }
	/** Still trusted some other way (e.g. a local unix socket proxy). */
	| { kind: "still-trusted"; session: IncusSession }
	/** `incus webui` proxies with the CLI's credentials; nothing to sign out of. */
	| { kind: "webui" }
	| { kind: "error"; error: IncusApiError | null };

export const LOGOUT_PATHS = ["/tls/logout", "/oidc/logout"] as const;

/** `incus webui` serves the UI over plain HTTP on loopback; Incus itself is HTTPS only. */
export function isWebuiOrigin(location: {
	protocol: string;
	hostname: string;
}): boolean {
	return (
		location.protocol === "http:" &&
		(location.hostname === "127.0.0.1" || location.hostname === "[::1]")
	);
}

/** Clears Incus session cookies and local hints, then re-reads the session. */
export async function signOut(deps: {
	fetchImpl?: typeof fetch;
	authStorage: Pick<AuthStorage, "clear">;
	/** Re-reads GET /1.0 and returns the new state. */
	refreshSession: () => Promise<SessionState>;
	/** Called before the session changes so the picker does not auto-redirect. */
	suppressAutoSignIn?: () => void;
	webui?: boolean;
}): Promise<SignOutResult> {
	deps.suppressAutoSignIn?.();
	deps.authStorage.clear();
	if (deps.webui) return { kind: "webui" };
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
	// Responses are not always envelopes and /oidc/logout is 404 without OIDC.
	await Promise.all(
		LOGOUT_PATHS.map((path) =>
			fetchImpl(path, { method: "POST", credentials: "same-origin" }).then(
				(response) => response.body?.cancel(),
				() => undefined,
			),
		),
	);
	const state = await deps.refreshSession();
	if (state.status === "error") return { kind: "error", error: state.error };
	if (state.status === "loading") return { kind: "error", error: null };
	const { session } = state;
	if (!session.trusted) return { kind: "signed-out", session };
	if (session.authUserMethod === "tls") return { kind: "certificate", session };
	return { kind: "still-trusted", session };
}

/** How the current session signed in, for the user menu. */
export function signInLabel(
	authUserMethod: string | null,
	lastMethod: AuthMethodUsed | null,
	webui: boolean,
): string {
	if (webui) return "incus webui";
	switch (authUserMethod) {
		case "tls":
			return lastMethod === "tls-token" ? "Client token" : "TLS certificate";
		case "oidc":
			return "Single sign-on";
		case "unix":
			return "Local socket";
		case "cluster":
			return "Cluster member";
		default:
			return authUserMethod ?? "Unknown";
	}
}
