// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useSyncExternalStore } from "react";
import type { Project, ProjectField } from "@/lib/incus/projects";
import {
	ensureProject,
	projectsSnapshot,
	readProject,
	subscribeProjects,
} from "@/lib/incus/projects";
import type { DataResult } from "@/lib/incus/result";

function subscribe(listener: () => void): () => void {
	return subscribeProjects(listener);
}

function snapshot(): number {
	return projectsSnapshot();
}

export function useProject<const K extends ProjectField>(
	name: string,
	fields: readonly K[],
): DataResult<Pick<Project, K>> {
	const version = useSyncExternalStore(subscribe, snapshot, snapshot);
	useEffect(() => {
		if (version < 0) return;
		void ensureProject(name, fields);
	}, [version, name, fields]);
	return readProject(name, fields);
}
