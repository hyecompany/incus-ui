// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IncusApiError } from "../client.ts";
import type { IncusEvent } from "../events/types.ts";
import { ObservationStore, type Validation } from "./store.ts";

/** Event coverage as seen by the data layer. */
export type CoverageState = "connected" | "interrupted" | "unavailable";

export interface Coverage {
	state: CoverageState;
	epoch: number;
}

/** A consumer requirement. `key` identifies equivalent requirements. */
export interface Need {
	key: string;
}

export interface DataContext {
	readonly store: ObservationStore;
	readonly coverage: Coverage;
	now(): number;
	/** Validation for a fact learned right now (e.g. from an event). */
	eventValidation(): Validation;
	/** Fresh under the current coverage and freshness rules. */
	isFresh(validation: Validation | undefined): boolean;
	/** Whether a stale fact should be fetched now. */
	shouldValidate(validation: Validation | undefined): boolean;
}

/** One request a definition wants to send. Equal keys share one request. */
export interface PlannedRequest<N extends Need> {
	key: string;
	covers(need: N): boolean;
	/** Performs the request and returns how to apply it. */
	run(
		signal: AbortSignal,
	): Promise<(ctx: DataContext, validation: Validation) => void>;
}

/** Incus-specific knowledge for one resource type. */
export interface ResourceDefinition<N extends Need> {
	name: string;
	/** Applies an event to the store. Must be idempotent (events are replayed). */
	applyEvent(event: IncusEvent, ctx: DataContext): void;
	/** Whether the store cannot yet satisfy `need` as required. */
	needsFetch(need: N, ctx: DataContext): boolean;
	/** Chooses requests that supply every need passed in. */
	plan(needs: readonly N[], ctx: DataContext): PlannedRequest<N>[];
}

export interface DataCoreOptions {
	now?: () => number;
	/** Without event coverage, how long a validated fact counts as fresh. */
	uncoveredTtlMs?: number;
	/** First automatic retry delay after a failure; doubles per attempt up to 60s. */
	retryAfterMs?: number;
	maxConcurrent?: number;
}

interface Active<N extends Need> {
	definition: ResourceDefinition<N>;
	need: N;
	refs: number;
}

interface InFlight {
	definition: ResourceDefinition<Need>;
	request: PlannedRequest<Need>;
	journalStart: number;
	controller: AbortController;
}

/** Shared data layer core; one instance per deployment and session. */
export class DataCore {
	readonly store = new ObservationStore();
	private coverageState: Coverage = { state: "unavailable", epoch: 0 };
	private readonly definitions = new Set<ResourceDefinition<Need>>();
	private readonly active = new Map<string, Active<Need>>();
	private readonly inFlight = new Map<string, InFlight>();
	private readonly errors = new Map<
		string,
		{ error: IncusApiError; at: number; attempts: number; due: boolean }
	>();
	private readonly forced = new Set<string>();
	private readonly metaListeners = new Set<() => void>();
	private journal: { seq: number; event: IncusEvent }[] = [];
	private seq = 0;
	private scheduled = false;
	private disposed = false;
	private readonly now: () => number;
	private readonly uncoveredTtlMs: number;
	private readonly retryAfterMs: number;
	private readonly maxConcurrent: number;
	readonly context: DataContext;

	constructor(options: DataCoreOptions = {}) {
		this.now = options.now ?? Date.now;
		this.uncoveredTtlMs = options.uncoveredTtlMs ?? 30_000;
		this.retryAfterMs = options.retryAfterMs ?? 5_000;
		this.maxConcurrent = options.maxConcurrent ?? 4;
		const core = this;
		this.context = {
			store: this.store,
			get coverage() {
				return core.coverageState;
			},
			now: () => this.now(),
			eventValidation: () => ({
				at: this.now(),
				epoch:
					this.coverageState.state === "connected"
						? this.coverageState.epoch
						: null,
			}),
			isFresh: (validation) => this.isFresh(validation),
			shouldValidate: (validation) =>
				!this.isFresh(validation) && this.coverageState.state !== "interrupted",
		};
	}

	get coverage(): Coverage {
		return this.coverageState;
	}

	register<N extends Need>(definition: ResourceDefinition<N>): void {
		this.definitions.add(definition as unknown as ResourceDefinition<Need>);
	}

	/** Store, coverage, request and error changes. */
	subscribe(listener: () => void): () => void {
		const unsubscribeStore = this.store.subscribe(listener);
		this.metaListeners.add(listener);
		return () => {
			unsubscribeStore();
			this.metaListeners.delete(listener);
		};
	}

	/** Declares an active requirement; returns its release function. */
	activate<N extends Need>(
		definition: ResourceDefinition<N>,
		need: N,
	): () => void {
		const current = this.active.get(need.key);
		if (current) {
			current.refs += 1;
		} else {
			this.active.set(need.key, {
				definition: definition as unknown as ResourceDefinition<Need>,
				need,
				refs: 1,
			});
		}
		this.schedule();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const entry = this.active.get(need.key);
			if (!entry) return;
			entry.refs -= 1;
			if (entry.refs === 0) this.active.delete(need.key);
			// In-flight requests finish anyway: they may be shared and their facts are still useful.
		};
	}

	isFetching<N extends Need>(need: N): boolean {
		for (const flight of this.inFlight.values()) {
			if (flight.request.covers(need)) return true;
		}
		return false;
	}

	error(needKey: string): IncusApiError | null {
		return this.errors.get(needKey)?.error ?? null;
	}

	/** Revalidates `need` even if it looks satisfied or recently failed. */
	refresh(needKey: string): void {
		this.forced.add(needKey);
		this.errors.delete(needKey);
		this.emitMeta();
		this.schedule();
	}

	/** Re-checks every active requirement (e.g. on window focus). */
	revalidate(): void {
		this.schedule();
	}

	/** Coverage reported by the Events Layer. */
	setCoverage(state: CoverageState): void {
		const previous = this.coverageState;
		if (previous.state === state) return;
		this.coverageState = {
			state,
			// New coverage epoch: earlier facts need reconciling.
			epoch: state === "connected" ? previous.epoch + 1 : previous.epoch,
		};
		this.emitMeta();
		this.schedule();
	}

	/** An event from the Events Layer, in arrival order. */
	ingest(event: IncusEvent): void {
		if (this.disposed) return;
		this.seq += 1;
		if (this.inFlight.size > 0) this.journal.push({ seq: this.seq, event });
		this.store.batch(() => {
			for (const definition of this.definitions) {
				definition.applyEvent(event, this.context);
			}
		});
		this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		for (const flight of this.inFlight.values()) flight.controller.abort();
		this.inFlight.clear();
		this.active.clear();
		this.journal = [];
		this.metaListeners.clear();
	}

	private isFresh(validation: Validation | undefined): boolean {
		if (!validation) return false;
		const { state, epoch } = this.coverageState;
		if (state === "connected") return validation.epoch === epoch;
		if (state === "interrupted") return false;
		return this.now() - validation.at < this.uncoveredTtlMs;
	}

	private schedule(): void {
		if (this.scheduled || this.disposed) return;
		this.scheduled = true;
		// Plan once per microtask to combine requirements from the same tick.
		queueMicrotask(() => {
			this.scheduled = false;
			this.plan();
		});
	}

	private plan(): void {
		if (this.disposed) return;
		const byDefinition = new Map<ResourceDefinition<Need>, Need[]>();
		for (const { definition, need } of this.active.values()) {
			const forced = this.forced.has(need.key);
			const failed = this.errors.get(need.key);
			if (!forced && failed && !this.retryDue(failed)) continue;
			if (!forced && !definition.needsFetch(need, this.context)) continue;
			if (this.isFetching(need)) continue;
			const list = byDefinition.get(definition) ?? [];
			list.push(need);
			byDefinition.set(definition, list);
		}
		this.forced.clear();
		for (const [definition, needs] of byDefinition) {
			for (const request of definition.plan(needs, this.context)) {
				if (this.inFlight.size >= this.maxConcurrent) {
					return; // The rest is planned again when a request finishes.
				}
				if (!this.inFlight.has(request.key)) this.dispatch(definition, request);
			}
		}
	}

	private dispatch(
		definition: ResourceDefinition<Need>,
		request: PlannedRequest<Need>,
	): void {
		const validation = this.context.eventValidation();
		const flight: InFlight = {
			definition,
			request,
			journalStart: this.seq,
			controller: new AbortController(),
		};
		this.inFlight.set(request.key, flight);
		this.emitMeta();

		request
			.run(flight.controller.signal)
			.then((apply) => {
				if (this.disposed) return;
				// Settle first so data and "not fetching" publish together.
				this.inFlight.delete(request.key);
				this.store.batch(() => {
					apply(this.context, validation);
					// Events that arrived while the request was in flight win.
					for (const entry of this.journal) {
						if (entry.seq > flight.journalStart) {
							for (const def of this.definitions)
								def.applyEvent(entry.event, this.context);
						}
					}
				});
				for (const need of this.coveredNeeds(request))
					this.errors.delete(need.key);
			})
			.catch((cause: unknown) => {
				if (this.disposed) return;
				const error =
					cause instanceof IncusApiError
						? cause
						: new IncusApiError("network", "Request failed", { cause });
				if (error.kind === "aborted") return;
				for (const need of this.coveredNeeds(request)) {
					const attempts = (this.errors.get(need.key)?.attempts ?? 0) + 1;
					const failure = { error, at: this.now(), attempts, due: false };
					this.errors.set(need.key, failure);
					const delay = this.retryDelay(failure);
					if (delay !== null) {
						// The timer itself makes the retry due (independent of now()).
						setTimeout(() => {
							failure.due = true;
							this.schedule();
						}, delay);
					}
				}
			})
			.finally(() => {
				if (this.disposed) return;
				this.inFlight.delete(request.key);
				this.trimJournal();
				this.emitMeta();
				this.schedule();
			});
	}

	/** null: never retry automatically (needs refresh or a new session). */
	private retryDelay(failure: {
		error: IncusApiError;
		attempts: number;
	}): number | null {
		const { kind } = failure.error;
		if (kind === "auth" || kind === "forbidden" || kind === "malformed")
			return null;
		return Math.min(this.retryAfterMs * 2 ** (failure.attempts - 1), 60_000);
	}

	private retryDue(failure: { due: boolean }): boolean {
		return failure.due;
	}

	private coveredNeeds(request: PlannedRequest<Need>): Need[] {
		return [...this.active.values()]
			.map((entry) => entry.need)
			.filter((need) => request.covers(need));
	}

	private trimJournal(): void {
		if (this.inFlight.size === 0) {
			this.journal = [];
			return;
		}
		const oldest = Math.min(
			...[...this.inFlight.values()].map((f) => f.journalStart),
		);
		this.journal = this.journal.filter((entry) => entry.seq > oldest);
	}

	private emitMeta(): void {
		for (const listener of [...this.metaListeners]) listener();
	}
}
