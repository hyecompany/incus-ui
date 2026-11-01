// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/** Whether the certificate was generated on this page or the user brought their own. */
export type CertificateSource = "generated" | "existing";

export interface TlsFlowSearch {
	source?: CertificateSource;
}

export const validateTlsFlowSearch = (
	search: Record<string, unknown>,
): TlsFlowSearch =>
	search.source === "generated" || search.source === "existing"
		? { source: search.source }
		: {};

/** The server as the user's machine sees it. */
export function serverLocation() {
	const { hostname, origin } = window.location;
	const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
	return { hostname, origin, siteUrl: `${origin}${base}` };
}

/** Placeholder paths for a certificate the UI did not create. */
export const EXISTING_CERT_PATH = "~/path/to/client.crt";
export const EXISTING_KEY_PATH = "~/path/to/client.key";
