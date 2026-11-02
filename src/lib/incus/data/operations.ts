// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	IncusApiError,
	type IncusOperationRef,
	incusFetch,
} from "../client.ts";
import type { IncusEvent } from "../events/types.ts";

export type OperationStatus =
	| "Pending"
	| "Running"
	| "Success"
	| "Failure"
	| "Cancelled"
	| "Unknown";

const TERMINAL: ReadonlySet<OperationStatus> = new Set([
	"Success",
	"Failure",
	"Cancelled",
]);

/**
 * How this tab follows the operation.
 * "events": operation events (covered). "polling": long-polls /wait.
 * "lost": monitoring failed or the server forgot it; the server-side outcome is unknown.
 * "done": the server reported a terminal status.
 */
export type Monitoring = "events" | "polling" | "lost" | "done";

export interface OperationRecord {
	id: string;
	/** Project the operation runs in, when known. */
	project: string | undefined;
	description: string;
	status: OperationStatus;
	statusCode: number;
	/** Affected resource URLs by type, as Incus reports them. */
	resources: Readonly<Record<string, readonly string[]>>;
	err: string;
	mayCancel: boolean;
	createdAt: string;
	updatedAt: string;
	location: string;
	/** "local": started by this client. "observed": seen on the deployment. */
	origin: "local" | "observed";
	monitoring: Monitoring;
	/** Logical action this operation belongs to (several operations may share one). */
	group: string | undefined;
	/**
	 * After completion, the data the command affected is being revalidated.
	 * Server completion is not the same as refreshed data.
	 */
	reconciling: boolean;
	/** In memory only: may hold connection secrets (e.g. exec websockets). */
	metadata: unknown;
}

export interface OperationHandle {
	readonly id: string;
	get(): OperationRecord;
	subscribe(listener: () => void): () => void;
	/** Resolves once the server reports a terminal status; rejects if monitoring is lost. */
	wait(options?: { signal?: AbortSignal }): Promise<OperationRecord>;
	/** Asks the server to cancel (only when it says the operation may be cancelled). */
	cancel(): Promise<void>;
}

export interface RegisterOptions {
	project?: string;
	group?: string;
	/** Affected-data reconciliation; runs once when the operation ends (any outcome). */
	onDone?: (record: OperationRecord) => void | Promise<void>;
}

export interface OperationsOptions {
	now?: () => number;
	fetchImpl?: typeof fetch;
	/** Server-side timeout of one /wait long-poll, seconds. */
	waitTimeoutS?: number;
	/** How long finished operations are kept, ms. */
	retainMs?: number;
	maxRetained?: number;
	/** Delays between attempts when polling fails. */
	retryDelaysMs?: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

function parseStatus(value: unknown): OperationStatus {
	switch (value) {
		case "Pending":
		case "Running":
		case "Success":
		case "Failure":
		case "Cancelled":
			return value;
		case "Cancelling":
			return "Running";
		default:
			return "Unknown";
	}
}

interface ServerFields {
	id: string;
	description: string;
	status: OperationStatus;
	statusCode: number;
	resources: Record<string, string[]>;
	err: string;
	mayCancel: boolean;
	createdAt: string;
	updatedAt: string;
	location: string;
	project: string | undefined;
	metadata: unknown;
}

function parseOperation(value: unknown, project?: string): ServerFields | null {
	if (!isRecord(value) || typeof value.id !== "string" || !value.id)
		return null;
	const resources: Record<string, string[]> = {};
	if (isRecord(value.resources)) {
		for (const [type, urls] of Object.entries(value.resources)) {
			if (Array.isArray(urls))
				resources[type] = urls.filter(
					(u): u is string => typeof u === "string",
				);
		}
	}
	return {
		id: value.id,
		description: text(value.description),
		status: parseStatus(value.status),
		statusCode: typeof value.status_code === "number" ? value.status_code : 0,
		resources,
		err: text(value.err),
		mayCancel: value.may_cancel === true,
		createdAt: text(value.created_at),
		updatedAt: text(value.updated_at),
		location: text(value.location),
		project:
			typeof value.project === "string" && value.project
				? value.project
				: project,
		metadata: value.metadata,
	};
}

const rank = (status: OperationStatus) =>
	TERMINAL.has(status)
		? 3
		: status === "Running"
			? 2
			: status === "Pending"
				? 1
				: 0;

/**
 * Shared operation tracking. Records live here, not in components, so they
 * survive unmounts and project switches.
 */
export class OperationsRegistry {
	private readonly records = new Map<string, OperationRecord>();
	private readonly listeners = new Set<() => void>();
	private readonly recordListeners = new Map<string, Set<() => void>>();
	private readonly onDone = new Map<string, RegisterOptions["onDone"]>();
	private readonly finishedAt = new Map<string, number>();
	private readonly polling = new Map<string, AbortController>();
	private covered = false;
	private generation = 0;
	private readonly now: () => number;
	private readonly fetchImpl: typeof fetch | undefined;
	private readonly waitTimeoutS: number;
	private readonly retainMs: number;
	private readonly maxRetained: number;
	private readonly retryDelaysMs: readonly number[];

	constructor(options: OperationsOptions = {}) {
		this.now = options.now ?? Date.now;
		this.fetchImpl = options.fetchImpl;
		this.waitTimeoutS = options.waitTimeoutS ?? 30;
		this.retainMs = options.retainMs ?? 5 * 60_000;
		this.maxRetained = options.maxRetained ?? 200;
		this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 3_000, 10_000];
	}

	list(): OperationRecord[] {
		return [...this.records.values()];
	}

	get(id: string): OperationRecord | undefined {
		return this.records.get(id);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Registers an operation this client started. Must run before the command
	 * returns its handle; events that arrived first are merged, not lost.
	 */
	register(
		ref: IncusOperationRef,
		options: RegisterOptions = {},
	): OperationHandle {
		const fields =
			parseOperation(ref.metadata, options.project) ??
			(parseOperation({ id: ref.id }, options.project) as ServerFields);
		fields.id = ref.id;
		const existing = this.records.get(ref.id);
		if (options.onDone) this.onDone.set(ref.id, options.onDone);
		if (existing) {
			this.put({
				...existing,
				origin: "local",
				group: options.group ?? existing.group,
				project: existing.project ?? options.project,
			});
		}
		if (existing && TERMINAL.has(existing.status)) {
			// Completed (seen through events) before the response was processed.
			this.finish(ref.id);
			return this.handle(ref.id);
		}
		this.merge(
			{ ...fields, project: fields.project ?? options.project },
			"local",
		);
		if (!existing) this.patch(ref.id, { group: options.group });
		const record = this.records.get(ref.id) as OperationRecord;
		if (!TERMINAL.has(record.status) && !this.covered) this.poll(ref.id);
		return this.handle(ref.id);
	}

	handle(id: string): OperationHandle {
		return {
			id,
			get: () => this.records.get(id) as OperationRecord,
			subscribe: (listener) => this.subscribeTo(id, listener),
			wait: (options) => this.wait(id, options?.signal),
			cancel: () => this.cancel(id),
		};
	}

	/** An `operation` event from the Events Layer. */
	ingest(event: IncusEvent): void {
		if (event.type !== "operation") return;
		const fields = parseOperation(event.metadata, event.project);
		if (!fields) return;
		this.merge(fields, "observed");
	}

	/** Whether operation events currently reach this tab. */
	setCoverage(connected: boolean): void {
		const wasCovered = this.covered;
		this.covered = connected;
		for (const record of this.records.values()) {
			if (record.monitoring === "done" || record.monitoring === "lost")
				continue;
			if (!connected) {
				if (record.origin === "local") this.poll(record.id);
				else this.patch(record.id, { monitoring: "lost" });
			} else if (!wasCovered) {
				// Events do not replay: confirm what happened while uncovered.
				this.poll(record.id, true);
			}
		}
	}

	/** Events may have been missed (e.g. a suspended tab): confirm every open operation. */
	reconcile(): void {
		for (const record of this.records.values()) {
			if (record.monitoring !== "done" && record.monitoring !== "lost")
				this.poll(record.id, true);
		}
	}

	/** Forgets every record (logout). Does not cancel server operations. */
	clear(): void {
		this.generation += 1;
		for (const controller of this.polling.values()) controller.abort();
		this.polling.clear();
		this.records.clear();
		this.onDone.clear();
		this.finishedAt.clear();
		this.emit();
		for (const set of this.recordListeners.values())
			for (const l of [...set]) l();
	}

	private merge(fields: ServerFields, origin: "local" | "observed"): void {
		const current = this.records.get(fields.id);
		if (current) {
			if (TERMINAL.has(current.status)) return; // terminal is final
			// No server revision: keep the further-along state of overlapping reports.
			if (rank(fields.status) < rank(current.status)) return;
			if (
				rank(fields.status) === rank(current.status) &&
				fields.updatedAt &&
				current.updatedAt &&
				fields.updatedAt < current.updatedAt
			)
				return;
		}
		const next: OperationRecord = {
			...fields,
			project: fields.project ?? current?.project,
			origin: current?.origin ?? origin,
			monitoring: current?.monitoring ?? (this.covered ? "events" : "polling"),
			group: current?.group,
			reconciling: current?.reconciling ?? false,
		};
		if (TERMINAL.has(next.status)) next.monitoring = "done";
		else if (this.covered && next.monitoring !== "polling")
			next.monitoring = "events";
		this.put(next);
		if (TERMINAL.has(next.status)) this.finish(next.id);
	}

	private finish(id: string): void {
		this.polling.get(id)?.abort();
		this.polling.delete(id);
		this.finishedAt.set(id, this.now());
		const done = this.onDone.get(id);
		this.onDone.delete(id);
		if (done) {
			const generation = this.generation;
			this.patch(id, { reconciling: true });
			Promise.resolve()
				.then(() => done(this.records.get(id) as OperationRecord))
				.catch(() => undefined)
				.finally(() => {
					if (generation === this.generation)
						this.patch(id, { reconciling: false });
				});
		}
		this.prune();
	}

	/** Follows one operation over HTTP: long-polls /wait until it ends. */
	private poll(id: string, once = false): void {
		if (this.polling.has(id)) return;
		const controller = new AbortController();
		this.polling.set(id, controller);
		const generation = this.generation;
		if (!once) this.patch(id, { monitoring: "polling" });
		const run = async () => {
			let failures = 0;
			while (!controller.signal.aborted && generation === this.generation) {
				const record = this.records.get(id);
				if (!record || TERMINAL.has(record.status)) return;
				try {
					const response = await incusFetch<unknown>(
						`/1.0/operations/${encodeURIComponent(id)}${once ? "" : "/wait"}`,
						{
							query: {
								project: record.project,
								timeout: once ? undefined : String(this.waitTimeoutS),
							},
							signal: controller.signal,
							fetchImpl: this.fetchImpl,
						},
					);
					failures = 0;
					if (generation !== this.generation) return;
					const fields = parseOperation(response.metadata, record.project);
					if (fields) this.merge({ ...fields, id }, record.origin);
					if (once) return;
				} catch (cause) {
					if (controller.signal.aborted || generation !== this.generation)
						return;
					const error = cause instanceof IncusApiError ? cause : null;
					// Gone (Incus forgets finished operations) or no access: outcome unknown.
					const delay = this.retryDelaysMs[failures];
					if (
						error?.kind === "not-found" ||
						error?.kind === "forbidden" ||
						delay === undefined
					) {
						this.patch(id, { monitoring: "lost" });
						this.rejectWaiters(id);
						return;
					}
					failures += 1;
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		};
		void run().finally(() => {
			if (this.polling.get(id) === controller) this.polling.delete(id);
			const record = this.records.get(id);
			if (
				once &&
				record &&
				!TERMINAL.has(record.status) &&
				record.monitoring !== "lost"
			) {
				if (this.covered) this.patch(id, { monitoring: "events" });
				else if (record.origin === "local") this.poll(id);
			}
		});
	}

	private readonly waiters = new Map<string, Set<(error: Error) => void>>();

	private rejectWaiters(id: string): void {
		const set = this.waiters.get(id);
		this.waiters.delete(id);
		const error = new IncusApiError(
			"network",
			"Lost track of the operation; its outcome is unknown",
		);
		for (const reject of set ?? []) reject(error);
	}

	private wait(id: string, signal?: AbortSignal): Promise<OperationRecord> {
		return new Promise((resolve, reject) => {
			const check = () => {
				const record = this.records.get(id);
				if (!record) {
					stop();
					reject(
						new IncusApiError("aborted", "Operation tracking was cleared"),
					);
				} else if (TERMINAL.has(record.status)) {
					stop();
					resolve(record);
				} else if (record.monitoring === "lost") {
					stop();
					reject(
						new IncusApiError(
							"network",
							"Lost track of the operation; its outcome is unknown",
						),
					);
				}
			};
			const onAbort = () => {
				stop();
				reject(new IncusApiError("aborted", "Stopped waiting"));
			};
			let set = this.waiters.get(id);
			if (!set) {
				set = new Set();
				this.waiters.set(id, set);
			}
			const rejecter = (error: Error) => {
				stop();
				reject(error);
			};
			set.add(rejecter);
			const unsubscribe = this.subscribeTo(id, check);
			const stop = () => {
				unsubscribe();
				this.waiters.get(id)?.delete(rejecter);
				signal?.removeEventListener("abort", onAbort);
			};
			signal?.addEventListener("abort", onAbort);
			check();
		});
	}

	private async cancel(id: string): Promise<void> {
		const record = this.records.get(id);
		if (!record) throw new IncusApiError("not-found", "Unknown operation");
		if (TERMINAL.has(record.status)) return;
		if (!record.mayCancel) {
			throw new IncusApiError(
				"unsupported",
				"This operation cannot be cancelled",
			);
		}
		await incusFetch(`/1.0/operations/${encodeURIComponent(id)}`, {
			method: "DELETE",
			query: { project: record.project },
			fetchImpl: this.fetchImpl,
		});
	}

	private subscribeTo(id: string, listener: () => void): () => void {
		let set = this.recordListeners.get(id);
		if (!set) {
			set = new Set();
			this.recordListeners.set(id, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.recordListeners.delete(id);
		};
	}

	private patch(id: string, changes: Partial<OperationRecord>): void {
		const record = this.records.get(id);
		if (!record) return;
		if (
			Object.entries(changes).every(
				([k, v]) => record[k as keyof OperationRecord] === v,
			)
		)
			return;
		this.put({ ...record, ...changes });
	}

	private put(record: OperationRecord): void {
		this.records.set(record.id, record);
		this.emit();
		for (const listener of [...(this.recordListeners.get(record.id) ?? [])])
			listener();
	}

	/** Bounded retention of finished operations. */
	private prune(): void {
		const cutoff = this.now() - this.retainMs;
		const finished = [...this.finishedAt].sort((a, b) => a[1] - b[1]);
		let excess = this.records.size - this.maxRetained;
		for (const [id, at] of finished) {
			if (at >= cutoff && excess <= 0) break;
			if (this.records.get(id)?.reconciling) continue;
			this.records.delete(id);
			this.finishedAt.delete(id);
			excess -= 1;
		}
	}

	private emit(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

export const isTerminal = (status: OperationStatus) => TERMINAL.has(status);
