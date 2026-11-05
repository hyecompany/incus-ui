// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { DB_PREFIX } from "./persistence.ts";

/*
 * Logout cleanup. Coordination lives in localStorage and a BroadcastChannel,
 * never only inside the databases being deleted, so a resumed older tab can
 * tell that its session was wiped before it publishes or persists anything.
 */

const GENERATION_KEY = "incus-ui:data-generation";
const DATABASES_KEY = "incus-ui:data-databases";
export const CONTROL_CHANNEL = "incus-ui-control";

export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface WipeEnvironment {
	indexedDB?: IDBFactory;
	localStorage?: StorageLike;
	/** Posts the wipe to other tabs. */
	broadcast?: (message: WipeMessage) => void;
	/** How long to wait for a blocked deletion before reporting it. */
	blockedTimeoutMs?: number;
}

export interface WipeMessage {
	kind: "wipe";
	generation: number;
}

export interface WipeResult {
	/** Every Incus UI database was deleted and verified gone. */
	complete: boolean;
	blocked: string[];
	failed: string[];
}

function env(environment: WipeEnvironment) {
	return {
		indexedDB: environment.indexedDB ?? globalThis.indexedDB,
		localStorage:
			environment.localStorage ??
			(globalThis as { localStorage?: StorageLike }).localStorage,
	};
}

/** The current logout generation. Work from another generation must stop. */
export function readGeneration(environment: WipeEnvironment = {}): number {
	try {
		const raw = env(environment).localStorage?.getItem(GENERATION_KEY);
		const value = raw ? Number(raw) : 0;
		return Number.isFinite(value) ? value : 0;
	} catch {
		return 0;
	}
}

/** Remembers a database name outside IndexedDB so logout can find it. */
export function registerDatabase(
	name: string,
	environment: WipeEnvironment = {},
): void {
	const storage = env(environment).localStorage;
	if (!storage) return;
	try {
		const names = new Set(readDatabases(storage));
		if (names.has(name)) return;
		names.add(name);
		storage.setItem(DATABASES_KEY, JSON.stringify([...names]));
	} catch {
		// Without localStorage, indexedDB.databases() is the fallback.
	}
}

function readDatabases(storage: StorageLike | undefined): string[] {
	try {
		const parsed = JSON.parse(storage?.getItem(DATABASES_KEY) ?? "[]");
		return Array.isArray(parsed)
			? parsed.filter((n): n is string => typeof n === "string")
			: [];
	} catch {
		return [];
	}
}

/** In-tab hooks run synchronously on wipe (data layers clear memory and close DBs). */
const localHandlers = new Set<(generation: number) => void>();

export function onWipe(handler: (generation: number) => void): () => void {
	localHandlers.add(handler);
	return () => {
		localHandlers.delete(handler);
	};
}

async function listDatabases(
	idb: IDBFactory | undefined,
	storage: StorageLike | undefined,
): Promise<string[]> {
	const names = new Set(readDatabases(storage));
	try {
		const listed = (await idb?.databases?.()) ?? [];
		for (const db of listed) {
			if (db.name?.startsWith(DB_PREFIX)) names.add(db.name);
		}
	} catch {
		// databases() is not available everywhere; the registry covers it.
	}
	return [...names];
}

function deleteDatabase(
	idb: IDBFactory,
	name: string,
	blockedTimeoutMs: number,
): Promise<"deleted" | "blocked" | "failed"> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const finish = (outcome: "deleted" | "blocked" | "failed") => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(outcome);
		};
		const request = idb.deleteDatabase(name);
		request.onsuccess = () => finish("deleted");
		request.onerror = () => finish("failed");
		request.onblocked = () => {
			// Another connection is still open; it may close in response to the wipe.
			timer = setTimeout(() => finish("blocked"), blockedTimeoutMs);
		};
	});
}

/**
 * Wipes every Incus UI IndexedDB database (all deployments and accounts) and
 * clears in-memory data in every tab. Does not cancel server operations.
 */
export async function wipeIncusData(
	environment: WipeEnvironment = {},
): Promise<WipeResult> {
	const { indexedDB: idb, localStorage: storage } = env(environment);
	// 1. A new generation invalidates all earlier work, in every tab.
	const generation = readGeneration(environment) + 1;
	try {
		storage?.setItem(GENERATION_KEY, String(generation));
	} catch {
		// Still clear what we can; the broadcast reaches open tabs.
	}
	// 2-4. Stop accepting work, clear memory and close connections here and elsewhere.
	for (const handler of [...localHandlers]) handler(generation);
	environment.broadcast?.({ kind: "wipe", generation });
	if (!environment.broadcast && typeof BroadcastChannel !== "undefined") {
		const channel = new BroadcastChannel(CONTROL_CHANNEL);
		channel.postMessage({ kind: "wipe", generation } satisfies WipeMessage);
		channel.close();
	}
	if (!idb) return { complete: true, blocked: [], failed: [] };

	// 5. Delete every database.
	const names = await listDatabases(idb, storage);
	const blocked: string[] = [];
	const failed: string[] = [];
	await Promise.all(
		names.map(async (name) => {
			const outcome = await deleteDatabase(
				idb,
				name,
				environment.blockedTimeoutMs ?? 3_000,
			);
			if (outcome === "blocked") blocked.push(name);
			if (outcome === "failed") failed.push(name);
		}),
	);

	// 6. Verify, where the browser can list databases.
	try {
		const remaining = (await idb.databases?.()) ?? [];
		for (const db of remaining) {
			if (
				db.name?.startsWith(DB_PREFIX) &&
				!blocked.includes(db.name) &&
				!failed.includes(db.name)
			)
				failed.push(db.name);
		}
	} catch {
		// Not listable: rely on the deletion results.
	}
	const left = new Set([...blocked, ...failed]);
	try {
		storage?.setItem(
			DATABASES_KEY,
			JSON.stringify(names.filter((n) => left.has(n))),
		);
	} catch {
		// ignore
	}
	return { complete: left.size === 0, blocked, failed };
}

/** Listens for wipes from other tabs (BroadcastChannel and the storage event). */
export function listenForWipes(
	handler: (generation: number) => void,
): () => void {
	let channel: BroadcastChannel | null = null;
	if (typeof BroadcastChannel !== "undefined") {
		channel = new BroadcastChannel(CONTROL_CHANNEL);
		channel.onmessage = (event: MessageEvent) => {
			const message = event.data as Partial<WipeMessage> | null;
			if (message?.kind === "wipe" && typeof message.generation === "number")
				handler(message.generation);
		};
	}
	const onStorage = (event: StorageEvent) => {
		if (event.key === GENERATION_KEY && event.newValue)
			handler(Number(event.newValue));
	};
	globalThis.addEventListener?.("storage", onStorage as EventListener);
	return () => {
		channel?.close();
		globalThis.removeEventListener?.("storage", onStorage as EventListener);
	};
}
