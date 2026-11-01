// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IncusApiError } from "../../src/lib/incus/client.ts";
import type { IncusSession } from "../../src/lib/incus/session.ts";
import {
	browsersFor,
	defaultImportTarget,
	IMPORT_OSES,
	importGuide,
	pickBrowser,
} from "../../src/lib/incus/tls/browser-import.ts";
import {
	addCertificateCommand,
	certificateFileNames,
	defaultCertificateCopyCommand,
	downloadsPath,
	generatePfxPassword,
	remoteAddCommand,
	remoteNameFor,
	shellQuote,
	trustTokenCommand,
	webuiCommand,
} from "../../src/lib/incus/tls/certificate-files.ts";
import {
	connectionOutcome,
	enrollmentFailureMessage,
	enrollmentSucceeded,
} from "../../src/lib/incus/tls/enrollment.ts";

describe("certificate files and commands", () => {
	it("derives stable download names and a remote name from the hostname", () => {
		assert.deepEqual(certificateFileNames("Incus.Example.com"), {
			crt: "incus-ui-incus.example.com.crt",
			key: "incus-ui-incus.example.com.key",
			pfx: "incus-ui-incus.example.com.pfx",
		});
		assert.equal(remoteNameFor("[::1]"), "1");
		assert.equal(remoteNameFor("10.0.0.5"), "10.0.0.5");
		assert.equal(remoteNameFor(""), "incus");
		assert.equal(certificateFileNames("").crt, "incus-ui-incus.crt");
		assert.doesNotMatch(remoteNameFor("a:b/c=d"), /[:/=]/);
	});

	it("builds the incus remote add and webui commands", () => {
		const files = certificateFileNames("incus.example.com");
		assert.equal(
			remoteAddCommand({
				remote: "incus.example.com",
				url: "https://incus.example.com:8443",
				certPath: downloadsPath(files.crt),
				keyPath: downloadsPath(files.key),
			}),
			"incus remote add incus.example.com https://incus.example.com:8443 --auth-type=tls --tls-cert ~/Downloads/incus-ui-incus.example.com.crt --tls-key ~/Downloads/incus-ui-incus.example.com.key",
		);
		assert.equal(webuiCommand("incus.example.com"), "incus webui incus.example.com:");
		assert.equal(trustTokenCommand("my laptop"), "incus config trust add 'my laptop'");
		assert.equal(
			addCertificateCommand("~/Downloads/a.crt"),
			"incus config trust add-certificate ~/Downloads/a.crt",
		);
	});

	it("copies the files to the CLI's default certificate on Linux", () => {
		assert.equal(
			defaultCertificateCopyCommand({
				os: "linux",
				certPath: "~/Downloads/a.crt",
				keyPath: "~/Downloads/a.key",
			}),
			"mkdir -p ~/.config/incus && cp -n ~/Downloads/a.crt ~/.config/incus/client.crt && cp -n ~/Downloads/a.key ~/.config/incus/client.key",
		);
	});

	it("copies the files to the CLI's default certificate on macOS", () => {
		assert.equal(
			defaultCertificateCopyCommand({
				os: "macos",
				certPath: "~/Downloads/a.crt",
				keyPath: "~/Downloads/a.key",
			}),
			'mkdir -p "$HOME/Library/Application Support/incus" && cp -n ~/Downloads/a.crt "$HOME/Library/Application Support/incus"/client.crt && cp -n ~/Downloads/a.key "$HOME/Library/Application Support/incus"/client.key',
		);
	});

	it("quotes unsafe shell values but keeps ~/ expandable", () => {
		assert.equal(shellQuote("plain-1.crt"), "plain-1.crt");
		assert.equal(shellQuote("it's"), `'it'\\''s'`);
		assert.equal(shellQuote("~/My Files/a.crt"), "~/'My Files/a.crt'");
		assert.equal(shellQuote("$(rm)"), "'$(rm)'");
	});

	it("generates readable random pfx passwords", () => {
		const a = generatePfxPassword();
		assert.match(a, /^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
		assert.doesNotMatch(a, /[01ilo]/);
		assert.notEqual(a, generatePfxPassword());
		const zeros = { getRandomValues: <T extends ArrayBufferView | null>(b: T) => b };
		assert.equal(generatePfxPassword(zeros, 1), "aaaaa");
	});
});

describe("browser import guide", () => {
	it("preselects tabs from the detected platform", () => {
		assert.deepEqual(defaultImportTarget({ os: "macos", browser: "safari" }), {
			os: "macos",
			browser: "safari",
		});
		assert.deepEqual(defaultImportTarget({ os: "linux", browser: "safari" }), {
			os: "linux",
			browser: "chrome",
		});
		assert.deepEqual(defaultImportTarget({ os: "unknown", browser: "other" }), {
			os: "windows",
			browser: "chrome",
		});
		assert.equal(pickBrowser("windows", "safari"), "chrome");
		assert.equal(pickBrowser("windows", "edge"), "edge");
	});

	it("has numbered steps ending with a restart and the way back for every tab", () => {
		for (const os of IMPORT_OSES) {
			for (const browser of browsersFor(os)) {
				const guide = importGuide({
					os,
					browser,
					pfxFile: "incus-ui-host.pfx",
					siteUrl: "https://host:8443/ui/",
				});
				assert.ok(guide.steps.length >= 4, `${os}/${browser}`);
				assert.ok(guide.steps.some((s) => s.title.includes("password") || s.detail?.includes("password")));
				const [restart, back] = guide.steps.slice(-2);
				assert.match(restart.title, /restart|quit/i);
				assert.equal(back.copy?.value, "https://host:8443/ui/");
			}
		}
	});

	it("gives copyable browser URLs where pages cannot link", () => {
		const steps = (os: "linux" | "windows", browser: "chrome" | "edge") =>
			importGuide({ os, browser, pfxFile: "x.pfx", siteUrl: "u" }).steps;
		assert.equal(steps("linux", "chrome")[0].copy?.value, "chrome://certificate-manager");
		assert.equal(steps("linux", "edge")[0].copy?.value, "edge://certificate-manager");
		assert.ok(steps("windows", "edge").some((s) => s.copy?.value === "edge://restart"));
		assert.match(steps("windows", "chrome")[0].title, /x\.pfx/);
	});
});

describe("enrollment helpers", () => {
	const error = new IncusApiError("forbidden", "x", { status: 403 });

	it("explains each failure reason", () => {
		for (const reason of ["invalid-token", "already-trusted", "no-certificate", "not-ca-signed", "other"] as const) {
			const message = enrollmentFailureMessage(reason, { withCertificate: false });
			assert.ok(message.title && message.description);
		}
		assert.match(
			enrollmentFailureMessage("no-certificate", { withCertificate: true }).description,
			/7\.6/,
		);
		assert.match(
			enrollmentFailureMessage("other", { withCertificate: true, serverMessage: "boom" }).description,
			/boom/,
		);
		assert.equal(enrollmentFailureMessage("invalid-token", { withCertificate: true }).retry, true);
	});

	it("treats already-trusted as success", () => {
		assert.equal(enrollmentSucceeded({ ok: true }), true);
		assert.equal(enrollmentSucceeded({ ok: false, reason: "already-trusted", error }), true);
		assert.equal(enrollmentSucceeded({ ok: false, reason: "invalid-token", error }), false);
	});

	it("maps session state to a connection outcome", () => {
		const session = (trusted: boolean) => ({ trusted }) as IncusSession;
		assert.equal(connectionOutcome({ status: "ready", session: session(true) }), "trusted");
		assert.equal(connectionOutcome({ status: "ready", session: session(false) }), "untrusted");
		assert.equal(connectionOutcome({ status: "error", error }), "error");
		assert.equal(connectionOutcome({ status: "loading" }), "loading");
	});
});

describe("browser import guide for an existing certificate", () => {
	it("starts with a bundling step and uses placeholder paths", () => {
		const guide = importGuide({ os: "linux", browser: "chrome", siteUrl: "u" });
		assert.match(guide.steps[0].copy?.value ?? "", /^openssl pkcs12 -export .*PBE-SHA1-3DES/);
		assert.ok(guide.steps.some((s) => s.copy?.value.includes("~/path/to/client.p12")));
		assert.ok(guide.steps.every((s) => !s.title.includes("undefined")));
	});
});
