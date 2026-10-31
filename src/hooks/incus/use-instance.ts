// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useSyncExternalStore } from "react";
import type { Instance, InstanceField } from "@/lib/incus/instances";
import {
	projectScope,
	projectScopeVersion,
	subscribeProjectScope,
} from "@/lib/incus/project-scope";
import type { DataResult } from "@/lib/incus/result";
import {
	ensureInstance,
	readInstance,
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

export function useInstance<const K extends InstanceField>(
	name: string,
	fields: readonly K[],
	query: { project?: string } = {},
): DataResult<Pick<Instance, K>> {
	const version = useSyncExternalStore(subscribe, snapshot, snapshot);
	const scope = projectScope();
	const project =
		query.project ?? (scope.kind === "project" ? scope.name : undefined);
	const ambiguous = project === undefined;
	useEffect(() => {
		if (version < 0 || ambiguous) return;
		void ensureInstance(incusStore, name, fields, { project });
	}, [version, name, fields, project, ambiguous]);
	if (ambiguous) {
		return {
			data: undefined,
			available: false,
			complete: false,
			fresh: false,
			fetching: false,
			error: null,
		};
	}
	return readInstance(incusStore, name, fields, { project });
}
