// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { DataCore } from "./core.ts";
import type {
	CollectionSnapshot,
	RecordSnapshot,
	Validation,
} from "./store.ts";

/** The subset of BroadcastChannel used here (injectable for tests). */
export interface ChannelLike {
	postMessage(message: unknown): void;
	onmessage: ((event: { data: unknown }) => void) | null;
	close(): void;
}

/** One channel per deployment and authentication context. */
export function channelName(sessionKey: string): string {
	return `incus-ui-data:${encodeURIComponent(sessionKey)}`;
}

/** Validation on the wire: whether the sender considered the fact fresh. */
type WireValidation = Validation & { fresh?: boolean };

interface ObservationMessage {
	kind: "observations";
	from: string;
	/** Logout generation the sender lives in; others ignore stale senders. */
	generation: number;
	records: RecordSnapshot[];
	collections: CollectionSnapshot[];
}

export interface TabSyncOptions {
	tabId?: string;
	/** Logout generation (see wipe.ts). Messages from another generation are ignored. */
	generation?: () => number;
}

/**
 * Shares observations, deletions and invalidations between tabs of the same
 * deployment and session. Data stays correct without it; it only avoids
 * duplicate work and keeps tabs in step.
 */
export class TabSync {
	readonly tabId: string;
	private applying = false;
	private pending = new Set<string>();
	private scheduled = false;
	private unsubscribe: (() => void) | null = null;
	private readonly generation: () => number;

	private readonly core: DataCore;
	private readonly channel: ChannelLike;

	constructor(
		core: DataCore,
		channel: ChannelLike,
		options: TabSyncOptions = {},
	) {
		this.core = core;
		this.channel = channel;
		this.tabId = options.tabId ?? crypto.randomUUID();
		this.generation = options.generation ?? (() => 0);
	}

	start(): void {
		this.channel.onmessage = (event) => this.receive(event.data);
		this.unsubscribe = this.core.store.subscribe((changed) => {
			// Facts that came from another tab are not sent back (no loops).
			if (this.applying) return;
			for (const key of changed) this.pending.add(key);
			if (!this.scheduled) {
				this.scheduled = true;
				// One message per tick, however many facts a response produced.
				queueMicrotask(() => this.send());
			}
		});
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.channel.onmessage = null;
		this.pending.clear();
		this.channel.close();
	}

	private send(): void {
		this.scheduled = false;
		if (!this.unsubscribe) return;
		const store = this.core.store;
		const wire = (v: Validation): WireValidation => ({
			at: v.at,
			epoch: null,
			fresh: this.core.context.isFresh(v),
		});
		const records: RecordSnapshot[] = [];
		const collections: CollectionSnapshot[] = [];
		for (const key of this.pending) {
			const record = store.snapshotRecord(key);
			if (record) {
				records.push({
					...record,
					existence: record.existence && wire(record.existence),
					groups: record.groups.map((g) => ({
						...g,
						validation: wire(g.validation),
					})),
				});
				continue;
			}
			const collection = store.snapshotCollection(key);
			if (collection) {
				collections.push({
					...collection,
					validation: collection.validation && wire(collection.validation),
				});
			}
		}
		this.pending.clear();
		if (records.length === 0 && collections.length === 0) return;
		const message: ObservationMessage = {
			kind: "observations",
			from: this.tabId,
			generation: this.generation(),
			records,
			collections,
		};
		try {
			this.channel.postMessage(message);
		} catch {
			// Unclonable value or closed channel: sharing is an optimisation only.
		}
	}

	private receive(data: unknown): void {
		const message = data as Partial<ObservationMessage> | null;
		if (message?.kind !== "observations" || message.from === this.tabId) return;
		if (message.generation !== this.generation()) return;
		// Not newer just because it arrived later: the store merges by observation time.
		const translate = (v: Validation) =>
			this.core.remoteValidation(v, (v as WireValidation).fresh === true);
		this.applying = true;
		try {
			this.core.mutate((ctx) => {
				for (const record of message.records ?? [])
					ctx.store.mergeRecord(record, translate);
				for (const collection of message.collections ?? [])
					ctx.store.mergeCollection(collection, translate);
			});
		} finally {
			this.applying = false;
		}
	}
}
