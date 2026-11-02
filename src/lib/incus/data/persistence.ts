// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { DataCore, PersistencePolicy } from "./core.ts";
import {
	type CollectionSnapshot,
	type RecordSnapshot,
	typeOf,
	type Validation,
} from "./store.ts";

/** Bump when the stored shape changes: older databases are discarded, not read. */
export const SCHEMA_VERSION = 1;
export const DB_PREFIX = "incus-ui-data:";

export interface CommitBatch {
	records: Array<{ key: string; value: RecordSnapshot | null }>;
	collections: Array<{ key: string; value: CollectionSnapshot | null }>;
}

/** Storage behind the persistence queue. IndexedDB in the browser; in-memory in tests. */
export interface StorageBackend {
	/** Stored records and collections of the given type prefixes. */
	load(prefixes: {
		records: readonly string[];
		collections: readonly string[];
	}): Promise<{ records: RecordSnapshot[]; collections: CollectionSnapshot[] }>;
	/** Writes one batch atomically. */
	commit(batch: CommitBatch): Promise<void>;
	close(): void;
}

/** IndexedDB database name for one deployment and authentication context. */
export function databaseName(sessionKey: string): string {
	return `${DB_PREFIX}${encodeURIComponent(sessionKey)}`;
}

/* -------------------------------------------------------------- IndexedDB */

const RECORDS = "records";
const COLLECTIONS = "collections";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
		tx.onerror = () => reject(tx.error);
	});
}

const prefixRange = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`);

/**
 * Opens (or creates) one partition database. A schema change discards the
 * stored cache instead of interpreting it with the wrong rules.
 */
export function openIndexedDb(
	name: string,
	idb: IDBFactory = globalThis.indexedDB,
): Promise<StorageBackend> {
	return new Promise((resolve, reject) => {
		if (!idb) {
			reject(new Error("IndexedDB is unavailable"));
			return;
		}
		const open = idb.open(name, SCHEMA_VERSION);
		open.onupgradeneeded = () => {
			const db = open.result;
			for (const store of [...db.objectStoreNames]) db.deleteObjectStore(store);
			db.createObjectStore(RECORDS, { keyPath: "key" });
			db.createObjectStore(COLLECTIONS, { keyPath: "key" });
		};
		open.onerror = () => reject(open.error);
		open.onblocked = () => reject(new Error("IndexedDB open is blocked"));
		open.onsuccess = () => {
			const db = open.result;
			// Never block another tab's logout wipe or upgrade.
			db.onversionchange = () => db.close();
			resolve({
				async load(prefixes) {
					const tx = db.transaction([RECORDS, COLLECTIONS], "readonly");
					const records = tx.objectStore(RECORDS);
					const collections = tx.objectStore(COLLECTIONS);
					const [r, c] = await Promise.all([
						Promise.all(
							prefixes.records.map((p) =>
								request(records.getAll(prefixRange(p))),
							),
						),
						Promise.all(
							prefixes.collections.map((p) =>
								request(collections.getAll(prefixRange(p))),
							),
						),
					]);
					return {
						records: r.flat() as RecordSnapshot[],
						collections: c.flat() as CollectionSnapshot[],
					};
				},
				async commit(batch) {
					const tx = db.transaction([RECORDS, COLLECTIONS], "readwrite");
					const records = tx.objectStore(RECORDS);
					const collections = tx.objectStore(COLLECTIONS);
					for (const { key, value } of batch.records) {
						if (value) records.put(value);
						else records.delete(key);
					}
					for (const { key, value } of batch.collections) {
						if (value) collections.put(value);
						else collections.delete(key);
					}
					await done(tx);
				},
				close: () => db.close(),
			});
		};
	});
}

/** In-memory backend (tests, or when IndexedDB is unavailable). */
export class MemoryBackend implements StorageBackend {
	readonly records = new Map<string, RecordSnapshot>();
	readonly collections = new Map<string, CollectionSnapshot>();
	commits: CommitBatch[] = [];
	fail = false;

	async load(prefixes: {
		records: readonly string[];
		collections: readonly string[];
	}) {
		const by = <T>(map: Map<string, T>, list: readonly string[]) =>
			[...map]
				.filter(([key]) => list.some((p) => key.startsWith(p)))
				.map(([, v]) => structuredClone(v));
		return {
			records: by(this.records, prefixes.records),
			collections: by(this.collections, prefixes.collections),
		};
	}

	async commit(batch: CommitBatch) {
		if (this.fail) throw new Error("QuotaExceededError");
		this.commits.push(structuredClone(batch));
		for (const { key, value } of batch.records) {
			if (value) this.records.set(key, structuredClone(value));
			else this.records.delete(key);
		}
		for (const { key, value } of batch.collections) {
			if (value) this.collections.set(key, structuredClone(value));
			else this.collections.delete(key);
		}
	}

	close() {}
}

/* ------------------------------------------------------------------ queue */

export interface PersistenceOptions {
	/** Coalescing window before a write-back. */
	flushMs?: number;
	/** Most entries one transaction writes. */
	batchSize?: number;
	/** False once a logout wiped data: nothing more may be written. */
	isCurrent?: () => boolean;
	onError?: (error: unknown) => void;
}

const stored = (v: Validation): Validation => ({ at: v.at, epoch: null });
const restored = (v: Validation): Validation => ({
	at: v.at,
	epoch: null,
	source: "restored",
});

/**
 * Asynchronous write-back of permitted observations, and hydration. Consumers
 * never wait for it; a storage failure never affects the in-memory layer.
 */
export class Persistence {
	private readonly records = new Map<string, RecordSnapshot | null>();
	private readonly collections = new Map<string, CollectionSnapshot | null>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private flushing: Promise<void> | null = null;
	private hydrating = false;
	private stopped = false;
	private unsubscribe: (() => void) | null = null;
	private readonly flushMs: number;
	private readonly batchSize: number;
	private readonly isCurrent: () => boolean;
	private readonly onError: (error: unknown) => void;

	private readonly core: DataCore;
	private readonly backend: StorageBackend;

	constructor(
		core: DataCore,
		backend: StorageBackend,
		options: PersistenceOptions = {},
	) {
		this.core = core;
		this.backend = backend;
		this.flushMs = options.flushMs ?? 250;
		this.batchSize = options.batchSize ?? 500;
		this.isCurrent = options.isCurrent ?? (() => true);
		this.onError = options.onError ?? (() => undefined);
	}

	/** Starts queueing changes, then hydrates without blocking anything. */
	start(): Promise<void> {
		this.unsubscribe = this.core.store.subscribe((changed) => {
			if (!this.hydrating) this.enqueue(changed);
		});
		return this.hydrate();
	}

	/** Writes everything queued now (e.g. when the page is hidden). */
	flush(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (this.flushing) return this.flushing.then(() => this.flush());
		if (
			this.stopped ||
			(this.records.size === 0 && this.collections.size === 0)
		)
			return Promise.resolve();
		this.flushing = this.writeOne().finally(() => {
			this.flushing = null;
		});
		return this.flushing.then(() => {
			if (this.records.size || this.collections.size) return this.flush();
		});
	}

	/** Drops pending work and stops writing (logout, session change). */
	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.records.clear();
		this.collections.clear();
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.backend.close();
	}

	private policies(): PersistencePolicy[] {
		return this.core.resourceDefinitions
			.map((d) => d.persistence)
			.filter((p): p is PersistencePolicy => !!p);
	}

	private async hydrate(): Promise<void> {
		const policies = this.policies();
		const generation = this.core.currentGeneration;
		let loaded: Awaited<ReturnType<StorageBackend["load"]>>;
		try {
			loaded = await this.backend.load({
				records: policies.map((p) => p.recordPrefix),
				collections: policies
					.map((p) => p.collectionPrefix)
					.filter((p): p is string => !!p),
			});
		} catch (error) {
			this.onError(error);
			return;
		}
		if (this.stopped || !this.isCurrent() || !this.core.isCurrent(generation))
			return;
		const existing = new Set(
			loaded.records.filter((r) => r.exists === true).map((r) => r.key),
		);
		this.hydrating = true;
		try {
			this.core.mutate((ctx) => {
				for (const record of loaded.records)
					ctx.store.mergeRecord(record, restored);
				for (const collection of loaded.collections) {
					// Validated commit structure: "complete" only if every member made it.
					const intact = collection.members.every((m) => existing.has(m));
					ctx.store.mergeCollection(
						{ ...collection, complete: collection.complete && intact },
						restored,
					);
				}
			});
		} finally {
			this.hydrating = false;
		}
	}

	/** Filters before queueing: only allowlisted groups ever enter the queue. */
	private enqueue(changed: ReadonlySet<string>): void {
		if (this.stopped) return;
		const policies = new Map(this.policies().map((p) => [p.recordPrefix, p]));
		const collectionPolicies = new Map(
			this.policies()
				.filter((p) => p.collectionPrefix)
				.map((p) => [p.collectionPrefix as string, p]),
		);
		const store = this.core.store;
		for (const key of changed) {
			const prefix = typeOf(key);
			const policy = policies.get(prefix);
			if (policy) {
				const record = store.snapshotRecord(key);
				if (!record) continue; // cleared from memory: not a deletion on the server
				this.records.set(
					key,
					record.exists === true ? this.filter(policy, record) : null,
				);
				continue;
			}
			const collectionPolicy = collectionPolicies.get(prefix);
			if (collectionPolicy && (collectionPolicy.collection?.(key) ?? false)) {
				const collection = store.snapshotCollection(key);
				if (!collection) continue;
				this.collections.set(key, {
					...collection,
					validation: collection.validation && stored(collection.validation),
				});
			}
		}
		if (!this.timer && (this.records.size || this.collections.size)) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.flush();
			}, this.flushMs);
		}
	}

	private filter(
		policy: PersistencePolicy,
		record: RecordSnapshot,
	): RecordSnapshot {
		return {
			key: record.key,
			lifecycle: record.lifecycle,
			exists: true,
			existence: record.existence && stored(record.existence),
			groups: record.groups
				.filter((g) => policy.group(g.name, g.values))
				.map((g) => ({
					name: g.name,
					values: structuredClone(g.values),
					validation: stored(g.validation),
					invalid: g.invalid,
				})),
		};
	}

	private async writeOne(): Promise<void> {
		if (!this.isCurrent()) {
			// Logged out (possibly in another tab): never write again.
			this.stop();
			return;
		}
		const batch: CommitBatch = { records: [], collections: [] };
		for (const [key, value] of this.records) {
			if (batch.records.length >= this.batchSize) break;
			batch.records.push({ key, value });
		}
		for (const { key } of batch.records) this.records.delete(key);
		for (const [key, value] of this.collections) {
			if (batch.records.length + batch.collections.length >= this.batchSize)
				break;
			batch.collections.push({ key, value });
		}
		for (const { key } of batch.collections) this.collections.delete(key);
		try {
			await this.backend.commit(batch);
		} catch (error) {
			// Never roll back memory. Stop writing so a full disk is not retried forever.
			this.onError(error);
			this.stop();
		}
	}
}
