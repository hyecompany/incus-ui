// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { instanceCollectionPath, instancePath } from "./internal/paths.ts";
import { isRecord, readNumber, readString } from "./internal/values.ts";
import { incusRequest } from "./transport.ts";

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
		path: instanceCollectionPath({
			project,
			allProjects,
			representation,
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

export function instanceFromObject(value: Record<string, unknown>): Instance {
	return {
		name: readString(value, "name") ?? "",
		status: readString(value, "status") ?? "",
		statusCode: readNumber(value, "status_code") ?? 0,
		location: readString(value, "location") ?? "",
		type: readString(value, "type") ?? "",
		project: readString(value, "project") ?? "",
		architecture: readString(value, "architecture") ?? "",
		description: readString(value, "description") ?? "",
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
		path: instancePath(project, name),
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
