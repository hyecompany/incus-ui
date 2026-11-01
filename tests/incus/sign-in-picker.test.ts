// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	chooseAuthMethods,
	createAutoSignInGuard,
	lastUsedOption,
} from "../../src/lib/incus/auth-picker.ts";
import type { Platform } from "../../src/lib/platform.ts";

const linux: Platform = { os: "linux", browser: "firefox" };
const windows: Platform = { os: "windows", browser: "edge" };

const session = (
	authMethods: string[],
	uiConfig: Record<string, string> = {},
) => ({ authMethods, uiConfig });

describe("chooseAuthMethods", () => {
	it("offers server methods plus the CLI on Linux/macOS", () => {
		const d = chooseAuthMethods(session(["tls", "oidc"]), linux);
		assert.deepEqual(d.options, ["tls", "oidc", "cli"]);
		assert.equal(d.redirect, null);
		assert.equal(d.oidcUnavailable, false);
	});

	it("ignores unknown and duplicate methods", () => {
		const d = chooseAuthMethods(session(["tls", "unix", "tls"]), windows);
		assert.deepEqual(d.options, ["tls"]);
	});

	it("hides the CLI when offer_cli is false or the OS cannot run it", () => {
		const off = { "user.ui.auth.offer_cli": "false" };
		assert.deepEqual(
			chooseAuthMethods(session(["tls", "oidc"], off), linux).options,
			["tls", "oidc"],
		);
		assert.deepEqual(
			chooseAuthMethods(session(["tls", "oidc"]), windows).options,
			["tls", "oidc"],
		);
	});

	it("skips the picker when exactly one method remains", () => {
		assert.equal(
			chooseAuthMethods(session(["tls"]), windows).redirect,
			"tls",
		);
		assert.equal(
			chooseAuthMethods(session(["tls"]), windows, { choose: true }).redirect,
			null,
		);
	});

	it("auto-starts OIDC when configured and advertised", () => {
		const auto = { "user.ui.auth.auto_init_oidc": "true" };
		assert.equal(
			chooseAuthMethods(session(["tls", "oidc"], auto), linux).redirect,
			"oidc",
		);
		const legacy = { "user.ui.sso_only": "true" };
		assert.equal(
			chooseAuthMethods(session(["tls", "oidc"], legacy), linux).redirect,
			"oidc",
		);
	});

	it("reports auto OIDC without OIDC and behaves as if it were off", () => {
		const auto = { "user.ui.auth.auto_init_oidc": "true" };
		const d = chooseAuthMethods(session(["tls"], auto), linux);
		assert.equal(d.oidcUnavailable, true);
		assert.deepEqual(d.options, ["tls", "cli"]);
		assert.equal(d.redirect, null);
	});

	it("does not auto-redirect to OIDC while suppressed", () => {
		const auto = { "user.ui.auth.auto_init_oidc": "true" };
		const opts = { autoSignInSuppressed: true };
		assert.equal(
			chooseAuthMethods(session(["tls", "oidc"], auto), linux, opts).redirect,
			null,
		);
		assert.equal(
			chooseAuthMethods(session(["oidc"]), windows, opts).redirect,
			null,
		);
		assert.equal(
			chooseAuthMethods(session(["tls"]), windows, opts).redirect,
			"tls",
		);
	});

	it("shows an empty list when nothing is usable", () => {
		const d = chooseAuthMethods(session([]), windows);
		assert.deepEqual(d.options, []);
		assert.equal(d.redirect, null);
	});
});

describe("lastUsedOption", () => {
	it("maps stored methods to picker options", () => {
		assert.equal(lastUsedOption("tls-token"), "tls");
		assert.equal(lastUsedOption("tls"), "tls");
		assert.equal(lastUsedOption("oidc"), "oidc");
		assert.equal(lastUsedOption("webui"), "cli");
		assert.equal(lastUsedOption(null), null);
	});
});

describe("createAutoSignInGuard", () => {
	it("suppresses for two minutes and can be reset", () => {
		const data = new Map<string, string>();
		const storage = {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
			removeItem: (k: string) => void data.delete(k),
		};
		let now = 1_000_000;
		const guard = createAutoSignInGuard(storage, () => now);
		assert.equal(guard.suppressed(), false);
		guard.suppress();
		now += 60_000;
		assert.equal(guard.suppressed(), true);
		now += 61_000;
		assert.equal(guard.suppressed(), false);
		guard.suppress();
		guard.reset();
		assert.equal(guard.suppressed(), false);
	});

	it("tolerates missing or failing storage", () => {
		assert.equal(createAutoSignInGuard(null).suppressed(), false);
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
			removeItem: () => {
				throw new Error("denied");
			},
		};
		const guard = createAutoSignInGuard(broken);
		guard.suppress();
		assert.equal(guard.suppressed(), false);
	});
});
