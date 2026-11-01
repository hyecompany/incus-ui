// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { IncusApiError } from "../client.ts";
import type { DataCore, Need, ResourceDefinition } from "./core.ts";

/** A collection result. `data` only ever contains the selected fields. */
export interface CollectionResult<T> {
	/** Members whose selected fields are known; undefined if membership is unknown. */
	data: readonly T[] | undefined;
	/** Members known to exist whose selected fields are not known yet. */
	missing: readonly string[];
	/** Every member is present in `data` with every selected field. */
	available: boolean;
	/** Membership of the collection is complete. */
	complete: boolean;
	fresh: boolean;
	fetching: boolean;
	error: IncusApiError | null;
}

/** A single-resource result. `data` only ever contains the selected fields. */
export interface ResourceResult<T> {
	data: T | undefined;
	/** true: exists. false: known not to exist. undefined: unknown. */
	exists: boolean | undefined;
	available: boolean;
	fresh: boolean;
	fetching: boolean;
	error: IncusApiError | null;
}

export interface Watch<R> {
	subscribe(onChange: () => void): () => void;
	getSnapshot(): R;
}

function sameResult(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function watch<N extends Need, R>(
	core: DataCore,
	definition: ResourceDefinition<N>,
	need: N,
	compute: () => R,
): Watch<R> {
	let snapshot = compute();
	return {
		subscribe(onChange) {
			const release = core.activate(definition, need);
			const unsubscribe = core.subscribe(() => {
				const next = compute();
				// Only notify when this consumer's result actually changed.
				if (!sameResult(next, snapshot)) {
					snapshot = next;
					onChange();
				}
			});
			const next = compute();
			if (!sameResult(next, snapshot)) {
				snapshot = next;
				onChange();
			}
			return () => {
				unsubscribe();
				release();
			};
		},
		getSnapshot: () => snapshot,
	};
}

/** Resolves once the result is usable (available and settled) or failed. */
export function settle<
	R extends { available: boolean; fetching: boolean; error: unknown },
>(w: Watch<R>): Promise<R> {
	return new Promise((resolve) => {
		let done = false;
		const check = () => {
			const result = w.getSnapshot();
			if (!done && ((result.available && !result.fetching) || result.error)) {
				done = true;
				resolve(result);
			}
		};
		const stop = w.subscribe(() => {
			check();
			if (done) queueMicrotask(stop);
		});
		// Give the scheduler a chance to start fetching before checking.
		queueMicrotask(() => {
			check();
			if (done) stop();
		});
	});
}
