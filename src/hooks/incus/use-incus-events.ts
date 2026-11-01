// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { useEventsManager } from "@/components/providers/events-provider";
import type {
	EventStream,
	IncusEvent,
	IncusEventType,
	RecoveryNotice,
	ScopeStatus,
} from "@/lib/incus/events";
import {
	ALL_PROJECTS,
	type ProjectScope,
	projectScopeKey,
	scopeFromKey,
} from "@/lib/incus/project-scope";

export interface UseIncusEventsOptions {
	scope: ProjectScope;
	types: IncusEventType[];
	onEvent(event: IncusEvent): void;
	onRecovery?(notice: RecoveryNotice): void;
	onInterrupted?(status: ScopeStatus): void;
}

/** Subscribes to Incus events for a scope while mounted. */
export function useIncusEvents(options: UseIncusEventsOptions | null): void {
	const manager = useEventsManager();
	const latest = useRef(options);

	useEffect(() => {
		latest.current = options;
	});

	const scopeKey = options ? projectScopeKey(options.scope) : null;
	const typesKey = options
		? [...new Set(options.types)].sort().join(",")
		: null;

	useEffect(() => {
		const current = latest.current;
		if (!manager || !current || scopeKey === null || typesKey === null) {
			return;
		}
		const types =
			typesKey === "" ? [] : (typesKey.split(",") as IncusEventType[]);
		return manager.subscribe({
			scope: current.scope,
			types,
			onEvent: (event) => latest.current?.onEvent(event),
			onRecovery: (notice) => latest.current?.onRecovery?.(notice),
			onInterrupted: (status) => latest.current?.onInterrupted?.(status),
		});
	}, [manager, scopeKey, typesKey]);
}

/** Live status for one stream of a scope (default: core). */
export function useEventsStatus(
	scope: ProjectScope,
	stream: EventStream = "core",
): ScopeStatus {
	const manager = useEventsManager();
	const scopeKey = projectScopeKey(scope);
	// One scope object per key, so callers passing fresh literals share a snapshot.
	const stableScope = useMemo(
		() => scopeFromKey(scopeKey) ?? ALL_PROJECTS,
		[scopeKey],
	);

	const idle = useMemo<ScopeStatus>(
		() => ({ scope: stableScope, stream, state: "idle", generation: 0 }),
		[stableScope, stream],
	);

	const subscribe = useCallback(
		(onChange: () => void) =>
			manager ? manager.onStatus(onChange) : () => undefined,
		[manager],
	);
	const getSnapshot = useCallback(
		() => (manager ? manager.getStatus(stableScope, stream) : idle),
		[manager, stableScope, stream, idle],
	);

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
