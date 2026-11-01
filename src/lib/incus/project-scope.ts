// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { IncusQuery } from "./client.ts";

/** The UI project scope. */
export type ProjectScope = { kind: "all" } | { kind: "project"; name: string };

export const ALL_PROJECTS: ProjectScope = { kind: "all" };

/** Stable identity for a scope. Safe as a react-query key segment. */
export function projectScopeKey(scope: ProjectScope): string {
	return scope.kind === "all" ? "all" : `project:${scope.name}`;
}

/** Inverse of projectScopeKey. Returns null for anything it does not produce. */
export function scopeFromKey(key: string): ProjectScope | null {
	if (key === "all") {
		return ALL_PROJECTS;
	}
	if (key.startsWith("project:") && key.length > "project:".length) {
		return { kind: "project", name: key.slice("project:".length) };
	}
	return null;
}

export function isSameScope(a: ProjectScope, b: ProjectScope): boolean {
	return projectScopeKey(a) === projectScopeKey(b);
}

/** Which Incus endpoints accept the project scope. Declared per call site. */
export interface ScopeSupport {
	allProjects: boolean;
	project: boolean;
}

/** Query parameters that express the scope for one endpoint. */
export function projectScopeQuery(
	scope: ProjectScope,
	support: ScopeSupport,
): IncusQuery {
	if (scope.kind === "all" && support.allProjects) {
		return { "all-projects": "true" };
	}
	if (scope.kind === "project" && support.project) {
		return { project: scope.name };
	}
	return {};
}

export interface ProjectScopeStore {
	get(): ProjectScope;
	set(next: ProjectScope): void;
	subscribe(listener: () => void): () => void;
}

/** Framework-free store for useSyncExternalStore. */
export function createProjectScopeStore(
	initial: ProjectScope = ALL_PROJECTS,
): ProjectScopeStore {
	let current = initial;
	const listeners = new Set<() => void>();

	return {
		get: () => current,
		set(next) {
			if (isSameScope(current, next)) {
				return;
			}
			current = next;
			for (const listener of [...listeners]) {
				listener();
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
