// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useContext, useSyncExternalStore } from "react";
import { ProjectScopeContext } from "@/components/providers/project-scope-provider";
import { useProject } from "@/hooks/incus/use-projects";
import type { ProjectScope } from "@/lib/incus/project-scope";

export interface UseProjectScopeResult {
	scope: ProjectScope;
	setScope: (next: ProjectScope) => void;
	/** False only when the selected project is known not to exist. */
	isAvailable: boolean;
}

export function useProjectScope(): UseProjectScopeResult {
	const store = useContext(ProjectScopeContext);
	if (!store) {
		throw new Error("useProjectScope must be used within ProjectScopeProvider");
	}
	const scope = useSyncExternalStore(store.subscribe, store.get);
	// Existence only: answered from complete membership when it is known.
	const selected = useProject(scope.kind === "project" ? scope.name : null, [
		"name",
	]);
	return {
		scope,
		setScope: store.set,
		isAvailable: scope.kind === "all" || selected.exists !== false,
	};
}
