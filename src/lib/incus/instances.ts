// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IncusApiError, incusRequest } from "./client.ts";
import type { ProjectScope } from "./project-scope.ts";
import { projectScopeQuery } from "./project-scope.ts";

/** Instance fields the UI can select (ordinary representation). */
export interface Instance {
	name: string;
	project: string;
	status: string;
	statusCode: number;
	type: string;
	/** Cluster member; Incus reports "none" when not clustered. */
	location: string;
	architecture: string;
	description: string;
	createdAt: string;
	lastUsedAt: string;
	profiles: readonly string[];
}

export type InstanceField = keyof Instance;

/** Statuses accepted as query criteria. */
export type InstanceStatus =
	| "Running"
	| "Stopped"
	| "Frozen"
	| "Error"
	| "Ready"
	| "Starting"
	| "Stopping"
	| "Freezing"
	| "Aborting";

export interface InstanceIdentity {
	project: string;
	name: string;
}

export interface InstanceCriteria {
	status?: InstanceStatus;
}

/** The server filter for criteria, or undefined for no filter. */
export function instanceFilter(criteria: InstanceCriteria): string | undefined {
	return criteria.status ? `status eq ${criteria.status}` : undefined;
}

/** Local evaluation equivalent to instanceFilter on the server. */
export function matchesCriteria(
	status: string | undefined,
	criteria: InstanceCriteria,
): boolean | undefined {
	if (!criteria.status) return true;
	if (status === undefined) return undefined;
	return status.toLowerCase() === criteria.status.toLowerCase();
}

type Fetch = { signal?: AbortSignal; fetchImpl?: typeof fetch };

function collectionQuery(scope: ProjectScope, criteria: InstanceCriteria) {
	return {
		...projectScopeQuery(scope, { allProjects: true, project: true }),
		filter: instanceFilter(criteria),
	};
}

/** `GET /1.0/instances` (recursion=0, optionally filtered): identities only. */
export async function fetchInstanceIdentities(
	scope: ProjectScope,
	criteria: InstanceCriteria,
	opts: Fetch = {},
): Promise<InstanceIdentity[]> {
	const raw = await incusRequest<unknown>("/1.0/instances", {
		...opts,
		query: collectionQuery(scope, criteria),
	});
	if (!Array.isArray(raw) || !raw.every((url) => typeof url === "string")) {
		throw malformed("Instance list is not an array of URLs");
	}
	return raw.map((url) => instanceIdentityFromUrl(url, scope));
}

/** `GET /1.0/instances?recursion=1` (optionally filtered): ordinary objects. */
export async function fetchInstanceObjects(
	scope: ProjectScope,
	criteria: InstanceCriteria,
	opts: Fetch = {},
): Promise<Instance[]> {
	const raw = await incusRequest<unknown>("/1.0/instances", {
		...opts,
		query: { recursion: "1", ...collectionQuery(scope, criteria) },
	});
	if (!Array.isArray(raw)) {
		throw malformed("Instances response is not an array");
	}
	return raw.map((item, index) => parseInstanceObject(item, `index ${index}`));
}

/** `GET /1.0/instances/{name}?project=`: one instance, or null if absent. */
export async function fetchInstance(
	identity: InstanceIdentity,
	opts: Fetch = {},
): Promise<Instance | null> {
	try {
		const raw = await incusRequest<unknown>(
			`/1.0/instances/${encodeURIComponent(identity.name)}`,
			{ ...opts, query: { project: identity.project } },
		);
		return parseInstanceObject(raw, `"${identity.name}"`);
	} catch (error) {
		if (error instanceof IncusApiError && error.kind === "not-found") {
			return null;
		}
		throw error;
	}
}

/** Identity from an instance URL. */
export function instanceIdentityFromUrl(
	url: string,
	scope: ProjectScope,
): InstanceIdentity {
	const [path = "", query = ""] = url.split("?");
	const prefix = "/1.0/instances/";
	if (!path.startsWith(prefix) || path.length === prefix.length) {
		throw malformed(`Unexpected instance URL: ${url}`);
	}
	const project =
		new URLSearchParams(query).get("project") ??
		(scope.kind === "project" ? scope.name : "default");
	return { project, name: decodeURIComponent(path.slice(prefix.length)) };
}

export function parseInstanceObject(value: unknown, at: string): Instance {
	if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
		throw malformed(`Instance at ${at} has no name`);
	}
	const where = `Instance "${value.name}"`;
	const text = (field: string) => {
		const v = value[field] ?? "";
		if (typeof v !== "string")
			throw malformed(`${where} has an invalid ${field}`);
		return v;
	};
	const code = value.status_code ?? 0;
	if (typeof code !== "number" || !Number.isFinite(code)) {
		throw malformed(`${where} has an invalid status_code`);
	}
	const profiles = value.profiles ?? [];
	if (
		!Array.isArray(profiles) ||
		!profiles.every((p) => typeof p === "string")
	) {
		throw malformed(`${where} has invalid profiles`);
	}
	return {
		name: value.name,
		project: text("project") || "default",
		status: text("status"),
		statusCode: code,
		type: text("type"),
		location: text("location"),
		architecture: text("architecture"),
		description: text("description"),
		createdAt: text("created_at"),
		lastUsedAt: text("last_used_at"),
		profiles,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(message: string): IncusApiError {
	return new IncusApiError("malformed", message);
}
