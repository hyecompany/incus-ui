// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IncusApiError } from "./client.ts";

/** What the connected deployment supports, from `GET /1.0` (#7). */
export interface Capabilities {
	apiVersion: string;
	/** Every API extension the server advertises. */
	extensions: ReadonlySet<string>;
	clustered: boolean;
	/** False when the server did not report extensions (treat everything as supported). */
	known: boolean;
}

/** API extensions the data layer relies on, named as Incus advertises them. */
export const EXTENSIONS = {
	/** `filter=` on collection GETs. */
	filtering: "api_filtering",
	/** `all-projects=true` on `/1.0/instances`. */
	allProjects: "instance_all_projects",
	projects: "projects",
	/** `recursion=2` on `/1.0/instances` (full instances, including state). */
	instanceFull: "instance_get_full",
} as const;

export type Capability = keyof typeof EXTENSIONS;

/** Assumed when the server did not say: every capability is available. */
export const UNKNOWN_CAPABILITIES: Capabilities = {
	apiVersion: "",
	extensions: new Set(),
	clustered: false,
	known: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCapabilities(metadata: unknown): Capabilities {
	if (!isRecord(metadata)) return UNKNOWN_CAPABILITIES;
	const raw = metadata.api_extensions;
	const extensions = Array.isArray(raw)
		? raw.filter((e): e is string => typeof e === "string")
		: null;
	const environment = isRecord(metadata.environment)
		? metadata.environment
		: {};
	return {
		apiVersion:
			typeof metadata.api_version === "string" ? metadata.api_version : "",
		extensions: new Set(extensions ?? []),
		clustered: environment.server_clustered === true,
		known: extensions !== null,
	};
}

export function supports(
	capabilities: Capabilities,
	capability: Capability,
): boolean {
	return (
		!capabilities.known || capabilities.extensions.has(EXTENSIONS[capability])
	);
}

/** The explicit outcome for a representation the server cannot provide. */
export function unsupported(
	capability: Capability,
	what: string,
): IncusApiError {
	return new IncusApiError(
		"unsupported",
		`${what} needs the "${EXTENSIONS[capability]}" API extension, which this server does not have`,
	);
}
