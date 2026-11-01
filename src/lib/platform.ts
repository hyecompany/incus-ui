// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

export type OperatingSystem =
	| "windows"
	| "macos"
	| "linux"
	| "chromeos"
	| "android"
	| "ios"
	| "unknown";
export type BrowserFamily = "chrome" | "edge" | "firefox" | "safari" | "other";

export interface Platform {
	os: OperatingSystem;
	browser: BrowserFamily;
}

export interface PlatformInputs {
	userAgent: string;
	/** `navigator.userAgentData` (Chromium only). */
	userAgentData?: { platform?: string; brands?: { brand: string }[] } | null;
	maxTouchPoints?: number;
}

/** Best guess of OS and browser; a default for UI choices, not a fact. */
export function detectPlatform(inputs: PlatformInputs): Platform {
	const ua = inputs.userAgent;
	const hint = inputs.userAgentData?.platform?.toLowerCase() ?? "";
	let os: OperatingSystem = "unknown";
	if (hint === "windows" || /Windows NT/.test(ua)) os = "windows";
	else if (hint === "chrome os" || hint === "chromeos" || /CrOS/.test(ua))
		os = "chromeos";
	else if (hint === "android" || /Android/.test(ua)) os = "android";
	else if (/iPhone|iPad|iPod/.test(ua)) os = "ios";
	else if (hint === "macos" || /Macintosh|Mac OS X/.test(ua)) {
		// iPadOS Safari reports itself as a Mac.
		os = (inputs.maxTouchPoints ?? 0) > 1 ? "ios" : "macos";
	} else if (hint === "linux" || /Linux/.test(ua)) os = "linux";

	const brands = inputs.userAgentData?.brands?.map((b) => b.brand) ?? [];
	let browser: BrowserFamily = "other";
	if (brands.includes("Microsoft Edge") || /Edg\//.test(ua)) browser = "edge";
	else if (/Firefox\//.test(ua)) browser = "firefox";
	else if (
		brands.includes("Google Chrome") ||
		brands.includes("Chromium") ||
		/Chrome\/|Chromium\/|CriOS\//.test(ua)
	)
		browser = "chrome";
	else if (/Safari\//.test(ua)) browser = "safari";
	return { os, browser };
}

/** The platform of the running browser. */
export function currentPlatform(): Platform {
	if (typeof navigator === "undefined")
		return { os: "unknown", browser: "other" };
	const nav = navigator as Navigator & {
		userAgentData?: PlatformInputs["userAgentData"];
	};
	return detectPlatform({
		userAgent: nav.userAgent,
		userAgentData: nav.userAgentData,
		maxTouchPoints: nav.maxTouchPoints,
	});
}

/** Linux and macOS users can run the Incus CLI flows (`incus webui`, `incus remote add`). */
export const supportsCliFlows = (platform: Platform) =>
	platform.os === "linux" || platform.os === "macos";
