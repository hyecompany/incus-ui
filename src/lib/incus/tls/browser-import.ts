// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { Platform } from "../../platform.ts";

export type ImportOs = "windows" | "macos" | "linux" | "chromeos";
export type ImportBrowser = "chrome" | "edge" | "firefox" | "safari";

export const IMPORT_OS_LABELS: Record<ImportOs, string> = {
	windows: "Windows",
	macos: "macOS",
	linux: "Linux",
	chromeos: "ChromeOS",
};

export const IMPORT_BROWSER_LABELS: Record<ImportBrowser, string> = {
	chrome: "Chrome",
	edge: "Edge",
	firefox: "Firefox",
	safari: "Safari",
};

const BROWSERS: Record<ImportOs, ImportBrowser[]> = {
	windows: ["chrome", "edge", "firefox"],
	macos: ["safari", "chrome", "firefox", "edge"],
	linux: ["chrome", "firefox", "edge"],
	chromeos: ["chrome"],
};

export const IMPORT_OSES = Object.keys(BROWSERS) as ImportOs[];

export const browsersFor = (os: ImportOs) => BROWSERS[os];

export interface ImportTarget {
	os: ImportOs;
	browser: ImportBrowser;
}

/** Tabs to preselect for the detected platform; falls back to the first supported browser. */
export function defaultImportTarget(platform: Platform): ImportTarget {
	const os: ImportOs =
		platform.os === "windows" ||
		platform.os === "macos" ||
		platform.os === "linux" ||
		platform.os === "chromeos"
			? platform.os
			: platform.os === "ios"
				? "macos"
				: "windows";
	return { os, browser: pickBrowser(os, platform.browser) };
}

/** Keeps the browser when switching OS tabs if that OS has it. */
export function pickBrowser(os: ImportOs, preferred: string): ImportBrowser {
	const list = BROWSERS[os];
	return list.find((b) => b === preferred) ?? list[0];
}

export interface ImportStep {
	title: string;
	detail?: string;
	/** Something to paste: a browser URL (pages cannot link to chrome://) or a shell command. */
	copy?: { value: string; kind: "url" | "command" };
}

export interface ImportGuideInput extends ImportTarget {
	/** File name of the downloaded .pfx; omitted for the user's own certificate. */
	pfxFile?: string;
	/** Where to come back to, e.g. `https://incus.example.com:8443/ui/`. */
	siteUrl: string;
}

export interface ImportGuide extends ImportTarget {
	steps: ImportStep[];
}

const url = (value: string) => ({ value, kind: "url" as const });
const command = (value: string) => ({ value, kind: "command" as const });

const scheme = (browser: ImportBrowser) =>
	browser === "edge" ? "edge" : "chrome";

function importSteps(input: ImportGuideInput): ImportStep[] {
	const { os, browser } = input;
	const pfxFile = input.pfxFile ?? "your .pfx or .p12 file";
	const pfxPath = input.pfxFile
		? `~/Downloads/${input.pfxFile}`
		: "~/path/to/client.p12";
	const password = input.pfxFile
		? "Enter the .pfx password you saved earlier."
		: "Enter the password that protects the file.";
	// Firefox can also read the Windows/macOS store, but its own store works on every OS.
	if (browser === "firefox") return firefoxSteps(pfxFile, password);
	if (os === "windows") {
		return [
			{
				title: `Open ${pfxFile}`,
				detail: "Double-click the file. The Certificate Import Wizard opens.",
			},
			{
				title: "Choose “Current User”, then Next",
				detail: "Keep the file that is already selected and click Next.",
			},
			{
				title: "Enter the password",
				detail: `${password} Leave “Include all extended properties” ticked, then click Next.`,
			},
			{
				title: "Let Windows pick the store",
				detail:
					"Keep “Automatically select the certificate store”, click Next, then Finish. It goes into your Personal certificates, which Chrome and Edge both use.",
			},
		];
	}
	if (os === "macos") {
		return [
			{
				title: `Open ${pfxFile}`,
				detail: "Double-click the file. Keychain Access opens.",
			},
			{
				title: "Add it to the “login” keychain",
				detail: `If asked, pick the login keychain. ${password}`,
			},
			{
				title: "Allow the browser to use the key",
				detail:
					browser === "safari"
						? "When you sign in, Safari asks you to pick the certificate, then macOS asks to use the key. Enter your Mac password and click “Always Allow”."
						: `When you sign in, ${IMPORT_BROWSER_LABELS[browser]} asks you to pick the certificate, then macOS asks to use the key. Enter your Mac password and click “Always Allow”.`,
			},
		];
	}
	const s = scheme(browser);
	if (os === "chromeos") {
		return [
			{
				title: "Open certificate settings",
				detail:
					"Paste this into the address bar. It opens Settings › Privacy and security › Security › Manage certificates.",
				copy: url("chrome://certificate-manager"),
			},
			{
				title: "Your certificates › Import",
				detail: `Choose ${pfxFile}. “Import and Bind” also works and keeps the key in the device's security chip.`,
			},
			{ title: "Enter the password", detail: password },
		];
	}
	return [
		{
			title: "Open the certificate manager",
			detail:
				"Paste this into the address bar. Browsers do not allow pages to link here, so copy it.",
			copy: url(`${s}://certificate-manager`),
		},
		{
			title: "Your certificates › Import",
			detail: `Choose ${pfxFile}. The file dialog may only show .p12 files; switch the filter to “All files” to see the .pfx.`,
		},
		{ title: "Enter the password", detail: password },
		{
			title: "Prefer the terminal?",
			detail:
				"This does the same for Chrome and Edge (not Snap or Flatpak builds). It needs pk12util from the libnss3-tools or nss-tools package.",
			copy: command(`pk12util -d sql:$HOME/.pki/nssdb -i ${pfxPath}`),
		},
	];
}

function firefoxSteps(pfxFile: string, password: string): ImportStep[] {
	return [
		{
			title: "Open the certificate settings",
			detail:
				"Paste this into the address bar, scroll to “Certificates” and click “View Certificates…”.",
			copy: url("about:preferences#privacy"),
		},
		{
			title: "Your Certificates › Import…",
			detail: `Choose ${pfxFile}. If Firefox has a Primary Password it asks for that first.`,
		},
		{ title: "Enter the password", detail: password },
	];
}

function restartStep(browser: ImportBrowser, os: ImportOs): ImportStep {
	const name = IMPORT_BROWSER_LABELS[browser];
	if (browser === "chrome" || browser === "edge") {
		return {
			title: `Fully restart ${name}`,
			detail: `${name} remembers its earlier certificate choice until every window is closed. Paste this to restart it completely; your tabs come back.`,
			copy: url(`${scheme(browser)}://restart`),
		};
	}
	return {
		title: `Fully quit ${name} and open it again`,
		detail:
			os === "macos"
				? `Press ⌘Q (closing the window is not enough), then reopen ${name}.`
				: `Close every ${name} window, then reopen it.`,
	};
}

// 3DES and a SHA-1 MAC so that macOS Keychain and older Windows accept the bundle.
const bundleStep: ImportStep = {
	title: "Only have .crt and .key files? Bundle them first",
	detail:
		"Browsers import a single password-protected .pfx/.p12 file. Skip this if you already have one; otherwise run this and choose a password when asked.",
	copy: command(
		"openssl pkcs12 -export -in ~/path/to/client.crt -inkey ~/path/to/client.key -out ~/client.p12 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1",
	),
};

/** Numbered steps to import a client certificate into one OS/browser and come back signed in. */
export function importGuide(input: ImportGuideInput): ImportGuide {
	const name = IMPORT_BROWSER_LABELS[input.browser];
	return {
		os: input.os,
		browser: input.browser,
		steps: [
			...(input.pfxFile ? [] : [bundleStep]),
			...importSteps(input),
			restartStep(input.browser, input.os),
			{
				title: "Come back here and pick the certificate",
				detail: `Open this address again. When ${name} asks which certificate to use, choose the one you imported${input.browser === "firefox" ? " and tick “Remember this decision”" : ""}. This page reopens where you left off.`,
				copy: url(input.siteUrl),
			},
		],
	};
}
