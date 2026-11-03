// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { IncusApiError } from "../client.ts";
import type { CollectionResult, ResourceResult } from "./consumers.ts";

/**
 * What a collection view should render. Cache first: anything known (restored,
 * prefetched or stale) is shown instead of a skeleton while it revalidates, so
 * skeletons only appear when there is nothing to show yet.
 */
export type CollectionView =
	| { kind: "skeleton" }
	| { kind: "error"; error: IncusApiError }
	| { kind: "empty" }
	/** `pending`: members known to exist whose fields are still loading. */
	| { kind: "data"; pending: number };

export function collectionView(
	result: Pick<
		CollectionResult<unknown>,
		"data" | "missing" | "complete" | "error"
	>,
): CollectionView {
	const { data, missing, complete, error } = result;
	if (data && (data.length > 0 || missing.length > 0))
		return { kind: "data", pending: missing.length };
	if (data && complete) return { kind: "empty" };
	if (error) return { kind: "error", error };
	return { kind: "skeleton" };
}

export type ResourceView =
	| { kind: "skeleton" }
	| { kind: "error"; error: IncusApiError }
	| { kind: "absent" }
	| { kind: "data" };

export function resourceView(
	result: Pick<ResourceResult<unknown>, "data" | "exists" | "error">,
): ResourceView {
	if (result.data !== undefined) return { kind: "data" };
	if (result.exists === false) return { kind: "absent" };
	if (result.error) return { kind: "error", error: result.error };
	return { kind: "skeleton" };
}
