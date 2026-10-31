// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useSyncExternalStore } from "react";
import type {
	Instance,
	InstanceField,
	InstanceQuery,
} from "@/lib/incus/instances";
import {
	projectScope,
	projectScopeVersion,
	subscribeProjectScope,
} from "@/lib/incus/project-scope";
import type { DataResult } from "@/lib/incus/result";
import {
	ensureInstances,
	readInstances,
	runtimeSnapshot,
	subscribeRuntime,
} from "@/lib/incus/runtime";
import { incusStore } from "@/lib/incus/store";

function subscribe(listener: () => void): () => void {
	const stopStore = incusStore.subscribe(listener);
	const stopRuntime = subscribeRuntime(listener);
	const stopScope = subscribeProjectScope(listener);
	return () => {
		stopStore();
		stopRuntime();
		stopScope();
	};
}

function snapshot(): number {
	return incusStore.version() + runtimeSnapshot() + projectScopeVersion();
}

function scopedQuery(query: InstanceQuery): InstanceQuery {
	if (query.project) return query;
	const scope = projectScope();
	if (scope.kind === "all") return { ...query, allProjects: true };
	return { ...query, project: scope.name };
}

export function useInstances<const K extends InstanceField>(
	fields: readonly K[],
	query: InstanceQuery = {},
): DataResult<Array<Pick<Instance, K>>> {
	const version = useSyncExternalStore(subscribe, snapshot, snapshot);
	const resolved = scopedQuery(query);
	const status = resolved.status ?? "";
	const project = resolved.project ?? "";
	const allProjects = resolved.allProjects === true;
	useEffect(() => {
		if (version < 0) return;
		void ensureInstances(incusStore, fields, {
			status: status.length > 0 ? status : undefined,
			project: project.length > 0 ? project : undefined,
			allProjects,
		});
	}, [version, fields, status, project, allProjects]);
	return readInstances(incusStore, fields, resolved);
}
