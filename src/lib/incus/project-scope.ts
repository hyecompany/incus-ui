// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

export type ProjectScope = { kind: "all" } | { kind: "project"; name: string };

const ALL: ProjectScope = { kind: "all" };

const listeners = new Set<() => void>();
let current: ProjectScope = ALL;
let version = 0;

function normalizeScope(scope: ProjectScope): ProjectScope {
	if (scope.kind === "all") return ALL;
	const name = scope.name.trim();
	if (name.length === 0) return ALL;
	return { kind: "project", name };
}

function scopesEqual(a: ProjectScope, b: ProjectScope): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "all") return true;
	return b.kind === "project" && a.name === b.name;
}

function notify(): void {
	version += 1;
	for (const listener of [...listeners]) listener();
}

export function projectScope(): ProjectScope {
	return current;
}

export function setProjectScope(scope: ProjectScope): void {
	const next = normalizeScope(scope);
	if (scopesEqual(current, next)) return;
	current = next;
	notify();
}

export function subscribeProjectScope(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function projectScopeVersion(): number {
	return version;
}

export function resetProjectScopeForTests(): void {
	current = ALL;
	version = 0;
	listeners.clear();
}
