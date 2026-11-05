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

const isPlain = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

/**
 * Returns `prev` if `next` is deeply equal to it; otherwise `next`, with every
 * deeply equal plain object or array inside it replaced by the one from `prev`.
 * Unchanged rows keep their identity, so memoized components skip re-rendering.
 * Non-plain objects (errors, Sets) are compared by reference.
 */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
	if (prev === next) return prev as T;
	const arrays = Array.isArray(prev) && Array.isArray(next);
	if (!arrays && !(isPlain(prev) && isPlain(next))) return next;
	const a = prev as Record<string, unknown>;
	const b = next as Record<string, unknown>;
	const prevKeys = Object.keys(a);
	const nextKeys = Object.keys(b);
	const copy = (arrays ? [] : {}) as Record<string, unknown>;
	let equal = prevKeys.length === nextKeys.length;
	for (const key of nextKeys) {
		const value = replaceEqualDeep(a[key], b[key]);
		copy[key] = value;
		if (value !== a[key] || (value === undefined && !(key in a))) equal = false;
	}
	return (equal ? prev : copy) as T;
}

export function watch<N extends Need, R>(
	core: DataCore,
	definition: ResourceDefinition<N>,
	need: N,
	compute: () => R,
): Watch<R> {
	let { result: snapshot, deps } = core.store.track(compute);
	/** Recomputes; returns whether the result changed. */
	const update = () => {
		const tracked = core.store.track(compute);
		deps = tracked.deps;
		const next = replaceEqualDeep(snapshot, tracked.result);
		if (next === snapshot) return false;
		snapshot = next;
		return true;
	};
	return {
		subscribe(onChange) {
			const release = core.activate(definition, need);
			const unsubscribe = core.subscribe((changed) => {
				// Store changes that touch nothing this consumer read cannot change it.
				if (changed && !deps.affectedBy(changed)) return;
				if (update()) onChange();
			});
			if (update()) onChange();
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
