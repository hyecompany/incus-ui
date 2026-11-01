// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "./internal/values.ts";
import type { IncusStore, InstanceSnapshot } from "./store.ts";

export const INSTANCE_PERSIST_FIELDS = [
	"name",
	"status",
	"statusCode",
	"location",
	"type",
	"project",
	"architecture",
	"description",
] as const;

export type InstancePersistField = (typeof INSTANCE_PERSIST_FIELDS)[number];

export type PersistedFields = Partial<{
	name: string;
	status: string;
	statusCode: number;
	location: string;
	type: string;
	project: string;
	architecture: string;
	description: string;
}>;

export type PersistedInstance = {
	deploymentId: string;
	project: string;
	name: string;
	fields: PersistedFields;
	sessionGeneration: number;
};

export type PersistenceAdapter = {
	write(records: PersistedInstance[]): Promise<void>;
	read(deploymentId: string): Promise<PersistedInstance[]>;
	destroy(): Promise<boolean>;
};

export type MemoryAdapter = PersistenceAdapter & {
	failNextWrite: boolean;
	failDestroy: boolean;
	readonly records: PersistedInstance[];
};

export type PersistenceQueue = {
	enqueue(record: PersistedInstance): void;
	flush(): Promise<void>;
	wipe(): Promise<{ deleted: boolean }>;
};

const OBJECT_STORE = "instances";

const STRING_FIELDS = [
	"name",
	"status",
	"location",
	"type",
	"project",
	"architecture",
	"description",
] as const satisfies readonly Exclude<InstancePersistField, "statusCode">[];

export function persistableInstance(
	record: Record<string, unknown>,
): PersistedFields {
	const fields: PersistedFields = {};
	for (const field of STRING_FIELDS) {
		const value = record[field];
		if (typeof value === "string") fields[field] = value;
	}
	const statusCode = finiteStatusCode(record);
	if (statusCode !== undefined) fields.statusCode = statusCode;
	return fields;
}

export function recordsFromAdapterResult(value: unknown): PersistedInstance[] {
	if (!Array.isArray(value)) return [];
	const records: PersistedInstance[] = [];
	for (const entry of value) {
		const parsed = parsePersistedInstance(entry);
		if (parsed) records.push(parsed);
	}
	return records;
}

/** Latest row per instance. A higher sessionGeneration wins; ties keep the later row. */
export function coalescePersistedInstances(
	records: readonly PersistedInstance[],
): PersistedInstance[] {
	const merged = new Map<string, PersistedInstance>();
	for (const record of records) {
		const key = instanceKey(record);
		const previous = merged.get(key);
		if (!previous || record.sessionGeneration >= previous.sessionGeneration) {
			merged.set(key, snapshot(record));
		}
	}
	return [...merged.values()];
}

export function persistedInstanceFromSnapshot(
	instance: InstanceSnapshot,
	sessionGeneration: number,
): PersistedInstance {
	const record: Record<string, unknown> = {
		name: instance.name,
		project: instance.project,
	};
	for (const field of INSTANCE_PERSIST_FIELDS) {
		const observation = instance.fields[field];
		if (!observation) continue;
		record[field] = observation.value;
	}
	return {
		deploymentId: instance.deploymentId,
		project: instance.project,
		name: instance.name,
		sessionGeneration,
		fields: persistableInstance(record),
	};
}

export function storeSessionGeneration(store: IncusStore): number {
	if (
		"sessionGeneration" in store &&
		typeof store.sessionGeneration === "number" &&
		Number.isFinite(store.sessionGeneration)
	) {
		return store.sessionGeneration;
	}
	return store.beginRead("", []).sessionGeneration;
}

export function createMemoryAdapter(): MemoryAdapter {
	const stored = new Map<string, PersistedInstance>();
	const adapter: MemoryAdapter = {
		failNextWrite: false,
		failDestroy: false,
		get records() {
			return [...stored.values()].map((record) => snapshot(record));
		},
		async write(records) {
			if (adapter.failNextWrite) {
				adapter.failNextWrite = false;
				throw new Error("write failed");
			}
			for (const record of records) {
				const next = snapshot(record);
				stored.set(instanceKey(next), next);
			}
		},
		async read(deploymentId) {
			const records: PersistedInstance[] = [];
			for (const record of stored.values()) {
				if (record.deploymentId !== deploymentId) continue;
				records.push(snapshot(record));
			}
			return records;
		},
		async destroy() {
			if (adapter.failDestroy) return false;
			stored.clear();
			return true;
		},
	};
	return adapter;
}

export function createPersistenceQueue(
	adapter: PersistenceAdapter,
	options?: { onWriteError?: (error: unknown) => void },
): PersistenceQueue {
	const pending = new Map<string, PersistedInstance>();
	let scheduled = false;
	let scheduleToken = 0;
	let epoch = 0;
	let current: Promise<void> | null = null;

	function report(error: unknown): void {
		if (!options?.onWriteError) return;
		try {
			options.onWriteError(error);
		} catch (listenerError) {
			void listenerError;
		}
	}

	function schedule(): void {
		if (scheduled) return;
		scheduled = true;
		const token = scheduleToken;
		queueMicrotask(() => {
			if (token !== scheduleToken) return;
			scheduled = false;
			void flush();
		});
	}

	function enqueue(record: PersistedInstance): void {
		const next = snapshot(record);
		pending.set(instanceKey(next), next);
		schedule();
	}

	function startWrite(): Promise<void> {
		if (pending.size === 0) return Promise.resolve();
		const seen = epoch;
		const batch = [...pending.values()];
		pending.clear();
		let tracked: Promise<void> = Promise.resolve();
		tracked = Promise.resolve().then(async () => {
			try {
				await adapter.write(batch);
			} catch (error) {
				if (seen === epoch) {
					for (const record of batch) {
						const key = instanceKey(record);
						if (!pending.has(key)) pending.set(key, record);
					}
				}
				report(error);
			} finally {
				if (current === tracked) current = null;
			}
		});
		current = tracked;
		return tracked;
	}

	function flush(): Promise<void> {
		scheduleToken += 1;
		scheduled = false;
		if (!current) return startWrite();
		return current.then(() => {
			if (pending.size === 0) return undefined;
			return startWrite();
		});
	}

	async function wipe(): Promise<{ deleted: boolean }> {
		scheduleToken += 1;
		scheduled = false;
		epoch += 1;
		pending.clear();
		if (current) await current;
		const deleted = await adapter.destroy();
		return { deleted: deleted === true };
	}

	return { enqueue, flush, wipe };
}

export function createIndexedDbAdapter(
	databaseName = "incus-ui",
): PersistenceAdapter {
	return {
		async write(records) {
			const factory = indexedDbFactory();
			if (!factory) throw new Error("IndexedDB is not available");
			const db = await openDatabase(factory, databaseName);
			try {
				if (records.length === 0) return;
				const transaction = db.transaction(OBJECT_STORE, "readwrite");
				const done = whenComplete(transaction);
				const store = transaction.objectStore(OBJECT_STORE);
				for (const record of records) store.put(snapshot(record));
				await done;
			} finally {
				db.close();
			}
		},
		async read(deploymentId) {
			const factory = indexedDbFactory();
			if (!factory) throw new Error("IndexedDB is not available");
			const db = await openDatabase(factory, databaseName);
			try {
				const transaction = db.transaction(OBJECT_STORE, "readonly");
				const done = whenComplete(transaction);
				const value = await requestResult(
					transaction.objectStore(OBJECT_STORE).getAll(),
				);
				await done;
				return recordsFromAdapterResult(value).filter(
					(record) => record.deploymentId === deploymentId,
				);
			} finally {
				db.close();
			}
		},
		destroy() {
			const factory = indexedDbFactory();
			if (!factory) return Promise.resolve(false);
			return new Promise((resolve) => {
				let settled = false;
				const finish = (deleted: boolean) => {
					if (settled) return;
					settled = true;
					resolve(deleted);
				};
				try {
					const request = factory.deleteDatabase(databaseName);
					request.onsuccess = () => finish(true);
					request.onerror = () => finish(false);
				} catch (error) {
					void error;
					finish(false);
				}
			});
		},
	};
}

export function applyRestoredInstances(
	store: IncusStore,
	records: readonly PersistedInstance[],
	applyRestored?: (store: IncusStore, records: PersistedInstance[]) => void,
): void {
	const ready = coalescePersistedInstances(records);
	if (applyRestored) {
		applyRestored(store, ready);
		return;
	}
	const session = storeSessionGeneration(store);
	const byProject = new Map<string, PersistedInstance[]>();
	for (const record of ready) {
		if (record.name.length === 0) continue;
		const group = byProject.get(record.project);
		if (group) group.push(record);
		else byProject.set(record.project, [record]);
	}
	for (const [project, group] of byProject) {
		const token = store.beginRead(
			project,
			group.map((record) => record.name),
		);
		if (token.sessionGeneration !== session) continue;
		for (const record of group) {
			store.applyInstanceFields(token, project, {
				...record.fields,
				name: record.name,
				project: record.project,
			});
		}
	}
}

export async function restorePersisted(
	store: IncusStore,
	adapter: PersistenceAdapter,
	deploymentId: string,
	applyRestored?: (store: IncusStore, records: PersistedInstance[]) => void,
): Promise<PersistedInstance[]> {
	const records = recordsFromAdapterResult(
		await adapter.read(deploymentId),
	).filter((record) => record.deploymentId === deploymentId);
	applyRestoredInstances(store, records, applyRestored);
	return coalescePersistedInstances(records);
}

function finiteStatusCode(record: Record<string, unknown>): number | undefined {
	if (
		typeof record.statusCode === "number" &&
		Number.isFinite(record.statusCode)
	) {
		return record.statusCode;
	}
	if (
		typeof record.status_code === "number" &&
		Number.isFinite(record.status_code)
	) {
		return record.status_code;
	}
	return undefined;
}

function instanceKey(record: {
	deploymentId: string;
	project: string;
	name: string;
}): string {
	return `${record.deploymentId}\0${record.project}\0${record.name}`;
}

function snapshot(record: PersistedInstance): PersistedInstance {
	const raw: Record<string, unknown> = {};
	if (isRecord(record.fields)) {
		for (const key of Object.keys(record.fields)) {
			raw[key] = record.fields[key as keyof PersistedFields];
		}
	}
	return {
		deploymentId: record.deploymentId,
		project: record.project,
		name: record.name,
		sessionGeneration: record.sessionGeneration,
		fields: persistableInstance(raw),
	};
}

function parsePersistedInstance(value: unknown): PersistedInstance | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.deploymentId !== "string") return undefined;
	if (typeof value.project !== "string") return undefined;
	if (typeof value.name !== "string" || value.name.length === 0)
		return undefined;
	if (
		typeof value.sessionGeneration !== "number" ||
		!Number.isFinite(value.sessionGeneration)
	) {
		return undefined;
	}
	return {
		deploymentId: value.deploymentId,
		project: value.project,
		name: value.name,
		sessionGeneration: value.sessionGeneration,
		fields: persistableInstance(isRecord(value.fields) ? value.fields : {}),
	};
}

function indexedDbFactory(): IDBFactory | null {
	const candidate = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
	if (
		!candidate ||
		typeof candidate.open !== "function" ||
		typeof candidate.deleteDatabase !== "function"
	) {
		return null;
	}
	return candidate;
}

function openDatabase(
	factory: IDBFactory,
	databaseName: string,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(databaseName, 1);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(OBJECT_STORE)) {
				database.createObjectStore(OBJECT_STORE, {
					keyPath: ["deploymentId", "project", "name"],
				});
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			reject(request.error ?? new Error("IndexedDB open failed"));
		};
	});
}

function whenComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const fail = () => {
			if (settled) return;
			settled = true;
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		};
		transaction.oncomplete = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		transaction.onabort = fail;
		transaction.onerror = (event) => {
			event.preventDefault();
			fail();
		};
	});
}

function requestResult(request: IDBRequest): Promise<unknown> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			reject(request.error ?? new Error("IndexedDB request failed"));
		};
	});
}
