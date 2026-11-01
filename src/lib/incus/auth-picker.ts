// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { type Platform, supportsCliFlows } from "../platform.ts";
import type { AuthMethodUsed } from "./auth-storage.ts";
import { authScreenOptions, type IncusSession } from "./session.ts";

/** A choice on the sign-in screen. "cli" is the `incus webui` flow. */
export type SignInOption = "tls" | "oidc" | "cli";

export interface AuthPickerDecision {
	options: SignInOption[];
	/** Skip the picker and start this flow right away. */
	redirect: SignInOption | null;
	/** `auto_init_oidc` is set but the server does not offer OIDC. */
	oidcUnavailable: boolean;
}

/** What the sign-in screen offers, and whether it can be skipped. */
export function chooseAuthMethods(
	session: Pick<IncusSession, "authMethods" | "uiConfig">,
	platform: Platform,
	opts: {
		/** The user asked to see every method ("Use another sign-in method"). */
		choose?: boolean;
		/** Auto OIDC already ran recently or the user just signed out. */
		autoSignInSuppressed?: boolean;
	} = {},
): AuthPickerDecision {
	const { offerCli, autoInitOidc } = authScreenOptions(session.uiConfig);
	const options: SignInOption[] = [];
	for (const method of session.authMethods) {
		if ((method === "tls" || method === "oidc") && !options.includes(method))
			options.push(method);
	}
	if (offerCli && supportsCliFlows(platform)) options.push("cli");

	const hasOidc = options.includes("oidc");
	let redirect: SignInOption | null = null;
	if (!opts.choose) {
		if (autoInitOidc && hasOidc && !opts.autoSignInSuppressed)
			redirect = "oidc";
		else if (
			options.length === 1 &&
			!(options[0] === "oidc" && opts.autoSignInSuppressed)
		)
			redirect = options[0];
	}
	return { options, redirect, oidcUnavailable: autoInitOidc && !hasOidc };
}

/** The picker option matching how the user last signed in. */
export function lastUsedOption(
	method: AuthMethodUsed | null,
): SignInOption | null {
	if (method === "tls" || method === "tls-token") return "tls";
	if (method === "oidc") return "oidc";
	if (method === "webui") return "cli";
	return null;
}

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const SUPPRESS_KEY = "incus-ui.auth.suppress-auto";
const SUPPRESS_MS = 2 * 60_000;

/** Stops automatic OIDC redirects right after one ran (loop guard) or after sign-out. */
export function createAutoSignInGuard(
	storage: SessionStorageLike | null = typeof sessionStorage === "undefined"
		? null
		: sessionStorage,
	now: () => number = Date.now,
) {
	return {
		suppressed: () => {
			try {
				const at = Number(storage?.getItem(SUPPRESS_KEY));
				return Number.isFinite(at) && at > 0 && now() - at < SUPPRESS_MS;
			} catch {
				return false;
			}
		},
		suppress: () => {
			try {
				storage?.setItem(SUPPRESS_KEY, String(now()));
			} catch {
				// Best-effort.
			}
		},
		reset: () => {
			try {
				storage?.removeItem(SUPPRESS_KEY);
			} catch {
				// Best-effort.
			}
		},
	};
}
