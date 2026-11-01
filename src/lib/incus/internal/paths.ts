// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { incusPath } from "../transport.ts";

// The default project is a bare path: /1.0/instances/{name}, with no project query.
export function instancePath(
	project: string,
	name: string,
	suffix?: string,
): string {
	const path = `/1.0/instances/${encodeURIComponent(name)}${suffix ?? ""}`;
	if (project === "default") return path;
	return incusPath(path, { project });
}

// Name-only lists (representation 0) omit recursion. Other lists set recursion=1.
// all-projects and the default project both omit the project parameter.
export function instanceCollectionPath(query: {
	project: string;
	allProjects: boolean;
	representation: 0 | 1;
	filter?: string;
}): string {
	return incusPath("/1.0/instances", {
		project:
			query.allProjects || query.project === "default"
				? undefined
				: query.project,
		"all-projects": query.allProjects ? "true" : undefined,
		recursion: query.representation === 0 ? undefined : "1",
		filter: query.filter,
	});
}

// No name is /1.0/projects. A name is one project. This does not add recursion.
export function projectPath(name?: string): string {
	if (name === undefined) return "/1.0/projects";
	return `/1.0/projects/${encodeURIComponent(name)}`;
}

export function operationPath(id: string): string {
	return `/1.0/operations/${encodeURIComponent(id)}`;
}

// A collection member is the instance path with no suffix.
export function memberUrl(project: string, name: string): string {
	return instancePath(project, name);
}
