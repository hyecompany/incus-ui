// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useSyncExternalStore } from "react";
import {
	useDataLayer,
	useSessionState,
} from "@/components/providers/data-provider";
import type {
	CollectionResult,
	ProjectsApi,
	ResourceResult,
	Watch,
} from "@/lib/incus/data/projects";
import type { Project, ProjectField } from "@/lib/incus/projects";
import type { SessionState } from "@/lib/incus/session";

type Selected<F extends readonly ProjectField[]> = Pick<
	Project,
	F[number] | "name"
>;

const noop = () => () => undefined;

/** Result shape while no data layer exists (session loading, failed or untrusted). */
function placeholder(session: SessionState) {
	return {
		data: undefined,
		available: false,
		fresh: false,
		fetching: session.status === "loading",
		error: session.status === "error" ? session.error : null,
	};
}

function useWatch<R>(watch: Watch<R> | null, fallback: R): R {
	return useSyncExternalStore(
		watch?.subscribe ?? noop,
		() => (watch ? watch.getSnapshot() : fallback),
		() => fallback,
	);
}

/** Field selections compared by value, so inline arrays do not resubscribe. */
const fieldsKey = (fields: readonly ProjectField[]) =>
	[...fields].sort().join(",");
const fromKey = (key: string) => key.split(",") as ProjectField[];

/** Projects visible to this session, with only the selected fields. */
export function useProjects<const F extends readonly ProjectField[]>(
	fields: F,
): CollectionResult<Selected<F>> {
	const layer = useDataLayer();
	const session = useSessionState();
	const key = fieldsKey(fields);
	const watch = useMemo(
		() => layer?.projects.watchList(fromKey(key)) ?? null,
		[layer, key],
	);
	const fallback = useMemo(
		() => ({ ...placeholder(session), missing: [], complete: false }),
		[session],
	);
	return useWatch(watch, fallback) as CollectionResult<Selected<F>>;
}

/** One project with only the selected fields. */
export function useProject<const F extends readonly ProjectField[]>(
	/** null: nothing to watch (keeps hook order stable for optional lookups). */
	name: string | null,
	fields: F,
): ResourceResult<Selected<F>> {
	const layer = useDataLayer();
	const session = useSessionState();
	const key = fieldsKey(fields);
	const watch = useMemo(
		() =>
			layer && name !== null ? layer.projects.watch(name, fromKey(key)) : null,
		[layer, name, key],
	);
	const fallback = useMemo(
		() => ({ ...placeholder(session), exists: undefined }),
		[session],
	);
	return useWatch(watch, fallback) as ResourceResult<Selected<F>>;
}

/** Imperative access (command handlers, loaders); null until a session is known. */
export function useProjectsApi(): ProjectsApi | null {
	return useDataLayer()?.projects ?? null;
}
