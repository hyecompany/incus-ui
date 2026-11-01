// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IncusApiError, incusRequest } from "./client.ts";

/** Project fields the UI can select. */
export interface Project {
	name: string;
	description: string;
	config: Readonly<Record<string, string>>;
}

export type ProjectField = keyof Project;

export const PROJECT_FIELDS: readonly ProjectField[] = [
	"name",
	"description",
	"config",
];

/** Fields carried by object representations (recursion=1, individual GET). */
export interface ProjectDetails {
	description: string;
	config: Readonly<Record<string, string>>;
}

type Fetch = { signal?: AbortSignal; fetchImpl?: typeof fetch };

/** `GET /1.0/projects` (recursion=0): project URLs. */
export async function fetchProjectNames(opts: Fetch = {}): Promise<string[]> {
	const raw = await incusRequest<unknown>("/1.0/projects", opts);
	if (!Array.isArray(raw) || !raw.every((url) => typeof url === "string")) {
		throw malformed("Project list is not an array of URLs");
	}
	return raw.map((url) => projectNameFromUrl(url));
}

/** `GET /1.0/projects?recursion=1`: membership plus every project's details. */
export async function fetchProjectObjects(
	opts: Fetch = {},
): Promise<Array<{ name: string } & ProjectDetails>> {
	const raw = await incusRequest<unknown>("/1.0/projects", {
		...opts,
		query: { recursion: "1" },
	});
	if (!Array.isArray(raw)) {
		throw malformed("Projects response is not an array");
	}
	return raw.map((item, index) => parseProjectObject(item, `index ${index}`));
}

/** `GET /1.0/projects/{name}`; null when it does not exist. */
export async function fetchProject(
	name: string,
	opts: Fetch = {},
): Promise<({ name: string } & ProjectDetails) | null> {
	try {
		const raw = await incusRequest<unknown>(
			`/1.0/projects/${encodeURIComponent(name)}`,
			opts,
		);
		return parseProjectObject(raw, `"${name}"`);
	} catch (error) {
		if (error instanceof IncusApiError && error.kind === "not-found") {
			return null;
		}
		throw error;
	}
}

export function projectNameFromUrl(url: string): string {
	const path = url.split("?")[0] ?? "";
	const prefix = "/1.0/projects/";
	if (!path.startsWith(prefix) || path.length === prefix.length) {
		throw malformed(`Unexpected project URL: ${url}`);
	}
	return decodeURIComponent(path.slice(prefix.length));
}

/** Validates one project object. */
export function parseProjectObject(
	value: unknown,
	at: string,
): { name: string } & ProjectDetails {
	if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
		throw malformed(`Project at ${at} has no name`);
	}
	const description = value.description ?? "";
	if (typeof description !== "string") {
		throw malformed(`Project "${value.name}" has an invalid description`);
	}
	const config = value.config ?? {};
	if (
		!isRecord(config) ||
		!Object.values(config).every((entry) => typeof entry === "string")
	) {
		throw malformed(`Project "${value.name}" has an invalid config`);
	}
	return {
		name: value.name,
		description,
		config: config as Record<string, string>,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(message: string): IncusApiError {
	return new IncusApiError("malformed", message);
}
