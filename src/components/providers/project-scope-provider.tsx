// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, type ReactNode, useState } from "react";
import {
	createProjectScopeStore,
	type ProjectScopeStore,
} from "@/lib/incus/project-scope";

export const ProjectScopeContext = createContext<ProjectScopeStore | null>(
	null,
);

/**
 * Holds the selected project scope for the lifetime of the mounted UI.
 * Starts in All Projects mode. Consume through useProjectScope.
 */
export function ProjectScopeProvider({ children }: { children: ReactNode }) {
	const [store] = useState(() => createProjectScopeStore());
	return (
		<ProjectScopeContext.Provider value={store}>
			{children}
		</ProjectScopeContext.Provider>
	);
}
