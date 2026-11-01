// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useSyncExternalStore } from "react";
import {
	useDataLayer,
	useSessionState,
} from "@/components/providers/data-provider";
import { useProjectScope } from "@/hooks/incus/use-project-scope";
import { IncusApiError } from "@/lib/incus/client";
import type {
	CollectionResult,
	ResourceResult,
	Watch,
} from "@/lib/incus/data/consumers";
import type { InstancesApi } from "@/lib/incus/data/instances";
import type {
	Instance,
	InstanceField,
	InstanceStatus,
} from "@/lib/incus/instances";
import {
	type ProjectScope,
	projectScopeKey,
	scopeFromKey,
} from "@/lib/incus/project-scope";
import type { SessionState } from "@/lib/incus/session";

type Selected<F extends readonly InstanceField[]> = Pick<
	Instance,
	F[number] | "name" | "project"
>;

export interface InstanceQuery {
	/** Explicit project; omitted = the shared project selection (#11). */
	project?: string;
	status?: InstanceStatus;
}

const noop = () => () => undefined;

function placeholder(
	session: SessionState,
	error: IncusApiError | null = null,
) {
	return {
		data: undefined,
		available: false,
		fresh: false,
		fetching: session.status === "loading" && !error,
		error: error ?? (session.status === "error" ? session.error : null),
	};
}

function useWatch<R>(watch: Watch<R> | null, fallback: R): R {
	return useSyncExternalStore(
		watch?.subscribe ?? noop,
		() => (watch ? watch.getSnapshot() : fallback),
		() => fallback,
	);
}

const fieldsKey = (fields: readonly InstanceField[]) =>
	[...fields].sort().join(",");
const fromKey = (key: string) => key.split(",") as InstanceField[];

/** The project scope a query runs in, resolved before any work is scheduled. */
function useResolvedScope(project: string | undefined): ProjectScope {
	const { scope } = useProjectScope();
	return project !== undefined ? { kind: "project", name: project } : scope;
}

/**
 * Instances with only the selected fields.
 *
 * ```ts
 * useInstances(["name"], { status: "Running" });          // current project
 * useInstances(["name"], { project: "production", status: "Running" });
 * ```
 * In All Projects mode, every project visible to the session is included.
 */
export function useInstances<const F extends readonly InstanceField[]>(
	fields: F,
	query: InstanceQuery = {},
): CollectionResult<Selected<F>> {
	const layer = useDataLayer();
	const session = useSessionState();
	const scope = useResolvedScope(query.project);
	const scopeKey = projectScopeKey(scope);
	const key = fieldsKey(fields);
	const status = query.status;
	const watch = useMemo(() => {
		const resolved = scopeFromKey(scopeKey);
		return layer && resolved
			? layer.instances.watchList(fromKey(key), resolved, { status })
			: null;
	}, [layer, scopeKey, key, status]);
	const fallback = useMemo(
		() => ({ ...placeholder(session), missing: [], complete: false }),
		[session],
	);
	return useWatch(watch, fallback) as CollectionResult<Selected<F>>;
}

const NEEDS_PROJECT = new IncusApiError(
	"malformed",
	"An instance name is only unique within a project: pass a project in All Projects mode",
);

/**
 * One instance with only the selected fields, in the current project unless
 * `project` is given. Instance names are unique per project, so in All
 * Projects mode a project must be passed.
 */
export function useInstance<const F extends readonly InstanceField[]>(
	name: string | null,
	fields: F,
	query: { project?: string } = {},
): ResourceResult<Selected<F>> {
	const layer = useDataLayer();
	const session = useSessionState();
	const scope = useResolvedScope(query.project);
	const project = scope.kind === "project" ? scope.name : null;
	const key = fieldsKey(fields);
	const watch = useMemo(
		() =>
			layer && name !== null && project !== null
				? layer.instances.watch({ project, name }, fromKey(key))
				: null,
		[layer, name, project, key],
	);
	const fallback = useMemo(
		() => ({
			...placeholder(
				session,
				name !== null && project === null ? NEEDS_PROJECT : null,
			),
			exists: undefined,
		}),
		[session, name, project],
	);
	return useWatch(watch, fallback) as ResourceResult<Selected<F>>;
}

/** Imperative access (command handlers, loaders); null until a session is known. */
export function useInstancesApi(): InstancesApi | null {
	return useDataLayer()?.instances ?? null;
}
