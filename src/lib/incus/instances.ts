// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { incusPath, incusRequest } from "./transport.ts";

export type Instance = {
	name: string;
	status: string;
	statusCode: number;
	location: string;
	type: string;
	project: string;
	architecture: string;
	description: string;
};

export type InstanceField = keyof Instance;

export const ALL_PROJECTS = "\0all";

export type InstanceQuery = {
	project?: string;
	status?: string;
	allProjects?: boolean;
};

export type InstanceCollectionRequest = {
	path: string;
	project: string;
	filter?: string;
	representation: 0 | 1;
};

const ORDINARY_FIELDS = [
	"name",
	"status",
	"statusCode",
	"location",
	"type",
	"project",
	"architecture",
	"description",
] as const satisfies readonly InstanceField[];

export function resolveProject(project: string | undefined): string {
	return project && project.length > 0 ? project : "default";
}

export function instanceRepresentation(
	fields: readonly InstanceField[],
): 0 | 1 {
	return fields.every((field) => field === "name") ? 0 : 1;
}

function filterLiteral(value: string): string {
	return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function instanceCollectionRequest(
	fields: readonly InstanceField[],
	query: InstanceQuery = {},
): InstanceCollectionRequest {
	const allProjects = query.allProjects === true && !query.project;
	const project = allProjects ? ALL_PROJECTS : resolveProject(query.project);
	const representation = instanceRepresentation(fields);
	const filter = query.status
		? `status eq ${filterLiteral(query.status)}`
		: undefined;
	return {
		path: incusPath("/1.0/instances", {
			project: allProjects || project === "default" ? undefined : project,
			"all-projects": allProjects ? "true" : undefined,
			recursion: representation === 0 ? undefined : "1",
			filter,
		}),
		project,
		filter,
		representation,
	};
}

export function collectionMemberKey(
	scope: string,
	project: string,
	name: string,
): string {
	return scope === ALL_PROJECTS ? `${project}\0${name}` : name;
}

export function collectionMemberIdentity(
	scope: string,
	stored: string,
): { project: string; name: string } {
	if (scope === ALL_PROJECTS) {
		const separator = stored.indexOf("\0");
		if (separator >= 0) {
			return {
				project: stored.slice(0, separator),
				name: stored.slice(separator + 1),
			};
		}
	}
	return { project: scope === ALL_PROJECTS ? "default" : scope, name: stored };
}

export function instanceCollectionKey(
	request: InstanceCollectionRequest,
): readonly [string, string, string, number, string] {
	return [
		"incus",
		"instances",
		request.project,
		request.representation,
		request.filter ?? "",
	];
}

export function instanceIdentityFromUrl(url: string): {
	name: string;
	project: string;
} {
	const parsed = new URL(url, "https://incus.local");
	const name = decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "");
	return {
		name,
		project: parsed.searchParams.get("project") ?? "default",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function instanceFromObject(value: Record<string, unknown>): Instance {
	return {
		name: stringField(value.name),
		status: stringField(value.status),
		statusCode: typeof value.status_code === "number" ? value.status_code : 0,
		location: stringField(value.location),
		type: stringField(value.type),
		project: stringField(value.project),
		architecture: stringField(value.architecture),
		description: stringField(value.description),
	};
}

export function pickInstance<K extends InstanceField>(
	instance: Instance,
	fields: readonly K[],
): Pick<Instance, K> {
	const picked = {} as Pick<Instance, K>;
	for (const field of fields) picked[field] = instance[field];
	return picked;
}

export async function fetchInstanceCollection(
	request: InstanceCollectionRequest,
	signal?: AbortSignal,
): Promise<Instance[]> {
	const response = await incusRequest<unknown>(request.path, { signal });
	if (!Array.isArray(response.metadata)) {
		throw new Error("Instance collection metadata was not a list");
	}
	if (request.representation === 0) {
		return response.metadata.map((entry) => {
			if (typeof entry !== "string") {
				throw new Error("Instance collection entry was not a URL");
			}
			const identity = instanceIdentityFromUrl(entry);
			return instanceFromObject({
				name: identity.name,
				project: identity.project,
			});
		});
	}
	return response.metadata.map((entry) => {
		if (!isRecord(entry)) {
			throw new Error("Instance collection entry was not an object");
		}
		return instanceFromObject(entry);
	});
}

export function instanceRequest(
	name: string,
	query: { project?: string } = {},
): { path: string; project: string } {
	const project = resolveProject(query.project);
	return {
		path: incusPath(`/1.0/instances/${encodeURIComponent(name)}`, {
			project: project === "default" ? undefined : project,
		}),
		project,
	};
}

export function instanceKey(
	name: string,
	project: string,
): readonly [string, string, string, string] {
	return ["incus", "instance", project, name];
}

export async function fetchInstance(
	name: string,
	query: { project?: string } = {},
	signal?: AbortSignal,
): Promise<Instance> {
	const request = instanceRequest(name, query);
	const response = await incusRequest<unknown>(request.path, { signal });
	if (!isRecord(response.metadata)) {
		throw new Error("Instance metadata was not an object");
	}
	return instanceFromObject(response.metadata);
}

export const ordinaryInstanceFields = ORDINARY_FIELDS;
