// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useRef, useSyncExternalStore } from "react";
import { useDataLayer } from "@/components/providers/data-provider";
import type { OperationRecord } from "@/lib/incus/data/operations";

const EMPTY: readonly OperationRecord[] = [];
const noop = () => () => undefined;

/**
 * Every tracked operation: started here ("local") or seen on the deployment
 * ("observed"), across all projects. For global activity UI.
 */
export function useOperations(): readonly OperationRecord[] {
	const operations = useDataLayer()?.operations ?? null;
	const cache = useRef<{ source: unknown; list: readonly OperationRecord[] }>({
		source: null,
		list: EMPTY,
	});
	const snapshot = useCallback(() => {
		if (!operations) return EMPTY;
		const list = operations.list();
		const previous = cache.current.list;
		// Same records (they are replaced on change): keep the snapshot identity.
		if (
			list.length === previous.length &&
			list.every((r, i) => r === previous[i])
		)
			return previous;
		cache.current = { source: operations, list };
		return list;
	}, [operations]);
	return useSyncExternalStore(
		operations ? (cb) => operations.subscribe(cb) : noop,
		snapshot,
		() => EMPTY,
	);
}

/** One operation's record, or undefined once it is no longer tracked. */
export function useOperation(id: string | null): OperationRecord | undefined {
	const operations = useDataLayer()?.operations ?? null;
	return useSyncExternalStore(
		operations && id ? (cb) => operations.subscribe(cb) : noop,
		() => (operations && id ? operations.get(id) : undefined),
		() => undefined,
	);
}
