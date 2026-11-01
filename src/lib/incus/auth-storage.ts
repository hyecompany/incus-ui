// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/** How the user last signed in; drives the token-expiry dialog. */
export type AuthMethodUsed = "tls" | "tls-token" | "oidc" | "webui";

/** Where to resume an interrupted TLS setup (e.g. after a browser restart). */
export type ResumeStep = "tls-browser-import";

const KEYS = {
	lastMethod: "incus-ui.auth.last-method",
	tokenExp: "incus-ui.auth.token-exp",
	resume: "incus-ui.auth.resume",
} as const;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const browserStorage = (): StorageLike | null =>
	typeof localStorage === "undefined" ? null : localStorage;

/** Small persisted auth hints. No credentials or tokens are ever stored. */
export function createAuthStorage(
	storage: StorageLike | null = browserStorage(),
) {
	const get = (key: string) => {
		try {
			return storage?.getItem(key) ?? null;
		} catch {
			return null;
		}
	};
	const set = (key: string, value: string | null) => {
		try {
			if (value === null) storage?.removeItem(key);
			else storage?.setItem(key, value);
		} catch {
			// Storage unavailable (private mode, quota): hints are best-effort.
		}
	};
	return {
		lastMethod: () => get(KEYS.lastMethod) as AuthMethodUsed | null,
		setLastMethod: (method: AuthMethodUsed | null) =>
			set(KEYS.lastMethod, method),
		/** Token `exp` claim in seconds since the epoch, when the token had one. */
		tokenExp: () => {
			const value = Number(get(KEYS.tokenExp));
			return Number.isFinite(value) && value > 0 ? value : null;
		},
		setTokenExp: (exp: number | null) =>
			set(KEYS.tokenExp, exp === null ? null : String(exp)),
		resume: () => get(KEYS.resume) as ResumeStep | null,
		setResume: (step: ResumeStep | null) => set(KEYS.resume, step),
		/** Manual sign-out: nothing should be resumed or explained afterwards. */
		clear: () => {
			for (const key of Object.values(KEYS)) set(key, null);
		},
	};
}

export type AuthStorage = ReturnType<typeof createAuthStorage>;
