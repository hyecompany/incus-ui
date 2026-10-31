// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useSyncExternalStore } from "react";
import type { Project, ProjectField } from "@/lib/incus/projects";
import {
	ensureProjects,
	projectsSnapshot,
	readProjects,
	subscribeProjects,
} from "@/lib/incus/projects";
import type { DataResult } from "@/lib/incus/result";

function subscribe(listener: () => void): () => void {
	return subscribeProjects(listener);
}

function snapshot(): number {
	return projectsSnapshot();
}

export function useProjects<const K extends ProjectField>(
	fields: readonly K[],
): DataResult<Array<Pick<Project, K>>> {
	const version = useSyncExternalStore(subscribe, snapshot, snapshot);
	useEffect(() => {
		if (version < 0) return;
		void ensureProjects(fields);
	}, [version, fields]);
	return readProjects(fields);
}
