// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { type Capabilities, UNKNOWN_CAPABILITIES } from "../capabilities.ts";
import { IncusApiError } from "../client.ts";
import type { IncusEvent } from "../events/types.ts";
import { OperationsRegistry } from "./operations.ts";
import { ObservationStore, type Validation } from "./store.ts";

/** Event coverage as seen by the data layer. */
export type CoverageState = "connected" | "interrupted" | "unavailable";

export interface Coverage {
	state: CoverageState;
	epoch: number;
	/** When the current epoch's coverage began (connected only). */
	since: number | null;
}

/** A consumer requirement. `key` identifies equivalent requirements. */
export interface Need {
	key: string;
}

export interface DataContext {
	readonly store: ObservationStore;
	readonly coverage: Coverage;
	/** What the connected deployment supports (#7). */
	readonly capabilities: Capabilities;
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
	/**
	 * Keys of the needs this request was planned for. It supplies them even when
	 * `covers` cannot tell (e.g. resolving an undecided member), so their
	 * fetching state, errors and backoff stay attached to it.
	 */
	planned?: Set<string>;
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
	/**
	 * Chooses requests that supply every need passed in. Needs in `forced` must
	 * be revalidated even if the store looks fresh (an explicit refresh).
	 */
	plan(
		needs: readonly N[],
		ctx: DataContext,
		forced: ReadonlySet<string>,
	): PlannedRequest<N>[];
	/**
	 * For facts without suitable events (sampled measurements): when `need` next
	 * becomes due for a new sample, or null. The core re-plans at that time.
	 */
	revalidateAt?(need: N, ctx: DataContext): number | null;
	/** Persistence and cross-tab policy. Absent: nothing of this type is persisted. */
	persistence?: PersistencePolicy;
}

/**
 * Explicit allowlist (never a denylist): unclassified groups and collections are
 * not persisted. A group is persisted whole or not at all, so a restored group is
 * never a silently partial representation.
 */
export interface PersistencePolicy {
	/** Type prefixes of the record keys this definition owns. */
	recordPrefix: string;
	collectionPrefix?: string;
	/** Whether this group with these values may be written to IndexedDB. */
	group(name: string, values: Readonly<Record<string, unknown>>): boolean;
	collection?(key: string): boolean;
}

export interface DataCoreOptions {
	now?: () => number;
	/** Without event coverage, how long a validated fact counts as fresh. */
	uncoveredTtlMs?: number;
	/** First automatic retry delay after a failure; doubles per attempt up to 60s. */
	retryAfterMs?: number;
	maxConcurrent?: number;
	capabilities?: Capabilities;
	fetchImpl?: typeof fetch;
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
	generation: number;
	done: Promise<void>;
}

/** Shared data layer core; one instance per deployment and session. */
export class DataCore {
	readonly store = new ObservationStore();
	/** Shared operation tracking; survives unmounts and project switches. */
	readonly operations: OperationsRegistry;
	private coverageState: Coverage = {
		state: "unavailable",
		epoch: 0,
		since: null,
	};
	/** Bumped by clear(): work started before it is discarded. */
	private generation = 0;
	private sampleTimer: ReturnType<typeof setTimeout> | null = null;
	private sampleDue = Number.POSITIVE_INFINITY;
	readonly capabilities: Capabilities;
	private readonly definitions = new Set<ResourceDefinition<Need>>();
	private readonly active = new Map<string, Active<Need>>();
	private readonly inFlight = new Map<string, InFlight>();
	private readonly errors = new Map<
		string,
		{ error: IncusApiError; at: number; attempts: number; due: boolean }
	>();
	private readonly forced = new Set<string>();
	private readonly metaListeners = new Set<() => void>();
	private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
	/** Events seen while requests were in flight, with the validation they had on arrival. */
	private journal: {
		seq: number;
		event: IncusEvent;
		validation: Validation;
	}[] = [];
	private uncoveredTimer: ReturnType<typeof setInterval> | null = null;
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
		this.capabilities = options.capabilities ?? UNKNOWN_CAPABILITIES;
		this.operations = new OperationsRegistry({
			now: this.now,
			fetchImpl: options.fetchImpl,
		});
		const core = this;
		this.context = {
			store: this.store,
			get coverage() {
				return core.coverageState;
			},
			capabilities: this.capabilities,
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

	/**
	 * Store, coverage, request and error changes. Store changes pass the keys
	 * that changed; everything else passes null (anything may have changed).
	 */
	subscribe(
		listener: (changed: ReadonlySet<string> | null) => void,
	): () => void {
		const unsubscribeStore = this.store.subscribe(listener);
		const meta = () => listener(null);
		this.metaListeners.add(meta);
		return () => {
			unsubscribeStore();
			this.metaListeners.delete(meta);
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

	/**
	 * Starts loading `need` ahead of a consumer (hover, likely navigation) and
	 * keeps it active for `holdMs`, so it is requested and kept current until
	 * the consumer mounts. Returns a function that ends the hold early.
	 */
	prefetch<N extends Need>(
		definition: ResourceDefinition<N>,
		need: N,
		holdMs = 15_000,
	): () => void {
		if (this.disposed) return () => undefined;
		const release = this.activate(definition, need);
		const timer = setTimeout(release, holdMs);
		return () => {
			clearTimeout(timer);
			release();
		};
	}

	/** Registered definitions (persistence and other tabs read their policies). */
	get resourceDefinitions(): readonly ResourceDefinition<Need>[] {
		return [...this.definitions];
	}

	/**
	 * Runs a one-off read (e.g. after a command) through the same scheduler:
	 * equal keys share one request, and events seen meanwhile still win.
	 */
	read<N extends Need>(
		definition: ResourceDefinition<N>,
		request: PlannedRequest<N>,
	): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const existing = this.inFlight.get(request.key);
		if (existing) return existing.done;
		return this.dispatch(
			definition as unknown as ResourceDefinition<Need>,
			request as unknown as PlannedRequest<Need>,
		);
	}

	/** Whether a request of `definition` that supplies `need` is in flight. */
	isFetching<N extends Need>(
		definition: ResourceDefinition<N>,
		need: N,
	): boolean {
		for (const flight of this.inFlight.values()) {
			if (
				flight.definition === (definition as unknown) &&
				supplies(flight.request, need)
			)
				return true;
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
			since: state === "connected" ? this.now() : null,
		};
		this.operations.setCoverage(state === "connected");
		this.emitMeta();
		this.schedule();
	}

	/**
	 * The tab was suspended or frozen: events may have been missed even if the
	 * socket looks open. Starts a new epoch so earlier facts get reconciled.
	 */
	resumed(): void {
		if (this.coverageState.state !== "connected") {
			this.schedule();
			return;
		}
		this.operations.reconcile();
		this.coverageState = {
			state: "connected",
			epoch: this.coverageState.epoch + 1,
			since: this.now(),
		};
		this.emitMeta();
		this.schedule();
	}

	/**
	 * Validation to use for a fact another tab observed at `remote.at`. It is
	 * fresh here only if this tab's own coverage was continuous since then.
	 */
	remoteValidation(remote: Validation, fresh: boolean): Validation {
		const { state, epoch, since } = this.coverageState;
		const covered =
			fresh && state === "connected" && since !== null && remote.at >= since;
		return { at: remote.at, epoch: covered ? epoch : null, source: "remote" };
	}

	/** Applies local writes (commands, hydration, other tabs) and re-plans. */
	mutate(work: (ctx: DataContext) => void): void {
		if (this.disposed) return;
		this.store.batch(() => work(this.context));
		this.schedule();
	}

	/** Whether `generation` (from currentGeneration) is still the live one. */
	isCurrent(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	get currentGeneration(): number {
		return this.generation;
	}

	/**
	 * Drops every in-memory fact, error and pending request. Work that started
	 * before this point can no longer write to the store.
	 */
	clear(): void {
		this.generation += 1;
		for (const flight of this.inFlight.values()) flight.controller.abort();
		this.inFlight.clear();
		this.errors.clear();
		this.forced.clear();
		this.journal = [];
		this.operations.clear();
		this.store.batch(() => this.store.clear());
		this.emitMeta();
		this.schedule();
	}

	/** An event from the Events Layer, in arrival order. */
	ingest(event: IncusEvent): void {
		if (this.disposed) return;
		if (event.type === "operation") {
			this.operations.ingest(event);
			return;
		}
		this.seq += 1;
		if (this.inFlight.size > 0)
			this.journal.push({
				seq: this.seq,
				event,
				validation: this.context.eventValidation(),
			});
		this.store.batch(() => {
			for (const definition of this.definitions) {
				definition.applyEvent(event, this.context);
			}
		});
		this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		this.operations.clear();
		if (this.sampleTimer) clearTimeout(this.sampleTimer);
		if (this.uncoveredTimer) clearInterval(this.uncoveredTimer);
		this.uncoveredTimer = null;
		for (const timer of this.retryTimers) clearTimeout(timer);
		this.retryTimers.clear();
		for (const flight of this.inFlight.values()) flight.controller.abort();
		this.inFlight.clear();
		this.active.clear();
		this.journal = [];
		this.metaListeners.clear();
	}

	private isFresh(validation: Validation | undefined): boolean {
		if (!validation) return false;
		// Persistence does not establish continuity across a closed session.
		if (validation.source === "restored") return false;
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
			if (this.isFetching(definition, need)) continue;
			const list = byDefinition.get(definition) ?? [];
			list.push(need);
			byDefinition.set(definition, list);
		}
		const forced = new Set(this.forced);
		this.forced.clear();
		this.armSampling();
		this.armUncovered();
		for (const [definition, needs] of byDefinition) {
			for (const request of definition.plan(needs, this.context, forced)) {
				const existing = this.inFlight.get(request.key);
				if (existing) {
					// Same request already running: it now also serves these needs.
					if (request.planned) {
						existing.request.planned ??= new Set();
						for (const key of request.planned)
							existing.request.planned.add(key);
						this.emitMeta();
					}
					continue;
				}
				if (this.inFlight.size >= this.maxConcurrent) {
					// Planned again when a request finishes; keep the explicit refreshes.
					for (const key of forced) this.forced.add(key);
					return;
				}
				this.dispatch(definition, request);
			}
		}
	}

	/** One timer for the earliest sampled fact an active consumer needs. */
	private armSampling(): void {
		let due = Number.POSITIVE_INFINITY;
		for (const { definition, need } of this.active.values()) {
			const at = definition.revalidateAt?.(need, this.context);
			if (at != null && at < due) due = at;
		}
		if (due === this.sampleDue) return;
		if (this.sampleTimer) clearTimeout(this.sampleTimer);
		this.sampleTimer = null;
		this.sampleDue = due;
		if (due === Number.POSITIVE_INFINITY) return;
		this.sampleTimer = setTimeout(
			() => {
				this.sampleTimer = null;
				this.sampleDue = Number.POSITIVE_INFINITY;
				this.schedule();
			},
			Math.max(0, due - this.now()),
		);
	}

	/**
	 * Without event coverage, facts expire after uncoveredTtlMs and nothing else
	 * would notice. While anything is watched, re-check periodically so expired
	 * facts are reported stale and revalidated.
	 */
	private armUncovered(): void {
		const needed =
			this.coverageState.state === "unavailable" && this.active.size > 0;
		if (needed === (this.uncoveredTimer !== null)) return;
		if (!needed) {
			clearInterval(this.uncoveredTimer as ReturnType<typeof setInterval>);
			this.uncoveredTimer = null;
			return;
		}
		this.uncoveredTimer = setInterval(
			() => {
				this.emitMeta();
				this.schedule();
			},
			Math.max(250, this.uncoveredTtlMs / 2),
		);
		// Never keeps a Node process (tests, SSR) alive on its own.
		(this.uncoveredTimer as { unref?: () => void }).unref?.();
	}

	private dispatch(
		definition: ResourceDefinition<Need>,
		request: PlannedRequest<Need>,
	): Promise<void> {
		const validation = this.context.eventValidation();
		const flight: InFlight = {
			definition,
			request,
			journalStart: this.seq,
			controller: new AbortController(),
			generation: this.generation,
			done: Promise.resolve(),
		};
		this.inFlight.set(request.key, flight);
		this.emitMeta();

		flight.done = request
			.run(flight.controller.signal)
			.then((apply) => {
				if (!this.isCurrent(flight.generation)) return;
				// Settle first so data and "not fetching" publish together.
				this.inFlight.delete(request.key);
				this.store.batch(() => {
					apply(this.context, validation);
					// Events that arrived while the request was in flight win, with the
					// validation they had then: a reconnect since must not make them fresh.
					for (const entry of this.journal) {
						if (entry.seq > flight.journalStart) {
							const ctx = this.replayContext(entry.validation);
							for (const def of this.definitions)
								def.applyEvent(entry.event, ctx);
						}
					}
				});
				for (const need of this.coveredNeeds(flight))
					this.errors.delete(need.key);
			})
			.catch((cause: unknown) => {
				if (!this.isCurrent(flight.generation)) return;
				const error =
					cause instanceof IncusApiError
						? cause
						: new IncusApiError("network", "Request failed", { cause });
				if (error.kind === "aborted") return;
				for (const need of this.coveredNeeds(flight)) {
					const attempts = (this.errors.get(need.key)?.attempts ?? 0) + 1;
					const failure = { error, at: this.now(), attempts, due: false };
					this.errors.set(need.key, failure);
					const delay = this.retryDelay(failure);
					if (delay !== null) {
						// The timer itself makes the retry due (independent of now()).
						const timer = setTimeout(() => {
							this.retryTimers.delete(timer);
							failure.due = true;
							this.schedule();
						}, delay);
						this.retryTimers.add(timer);
					}
				}
			})
			.finally(() => {
				if (!this.isCurrent(flight.generation)) return;
				this.inFlight.delete(request.key);
				this.trimJournal();
				this.emitMeta();
				this.schedule();
			});
		return flight.done;
	}

	/** null: never retry automatically (needs refresh or a new session). */
	private retryDelay(failure: {
		error: IncusApiError;
		attempts: number;
	}): number | null {
		const { kind } = failure.error;
		if (
			kind === "auth" ||
			kind === "forbidden" ||
			kind === "malformed" ||
			kind === "unsupported"
		)
			return null;
		return Math.min(this.retryAfterMs * 2 ** (failure.attempts - 1), 60_000);
	}

	private retryDue(failure: { due: boolean }): boolean {
		return failure.due;
	}

	private coveredNeeds(flight: InFlight): Need[] {
		return [...this.active.values()]
			.filter((entry) => entry.definition === flight.definition)
			.map((entry) => entry.need)
			.filter((need) => supplies(flight.request, need));
	}

	/** The context as it was when a journaled event arrived. */
	private replayContext(validation: Validation): DataContext {
		return Object.create(this.context, {
			eventValidation: { value: () => ({ ...validation }) },
		}) as DataContext;
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

function supplies(request: PlannedRequest<Need>, need: Need): boolean {
	return request.planned?.has(need.key) === true || request.covers(need);
}
