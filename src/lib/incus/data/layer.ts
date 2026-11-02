// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { Capabilities } from "../capabilities.ts";
import { DataCore, type DataCoreOptions } from "./core.ts";
import { createInstancesApi, type InstancesApiOptions } from "./instances.ts";
import {
	databaseName,
	openIndexedDb,
	Persistence,
	type StorageBackend,
} from "./persistence.ts";
import { createProjectsApi } from "./projects.ts";
import { type ChannelLike, channelName, TabSync } from "./sync.ts";
import {
	listenForWipes,
	onWipe,
	readGeneration,
	registerDatabase,
	type WipeResult,
	wipeIncusData,
} from "./wipe.ts";

export interface DataLayerOptions {
	/** `<deployment>/<method>:<user>`: partitions storage and tab sharing. */
	sessionKey: string;
	capabilities?: Capabilities;
	core?: DataCoreOptions;
	instances?: InstancesApiOptions;
	/** Storage backend; defaults to IndexedDB. null: memory only. */
	storage?: () => Promise<StorageBackend | null>;
	/** Tab channel; defaults to BroadcastChannel. null: no sharing. */
	channel?: (() => ChannelLike) | null;
	onPersistenceError?: (error: unknown) => void;
}

/** One data layer per deployment and session. */
export function createDataLayer(options: DataLayerOptions) {
	const core = new DataCore({
		...options.core,
		capabilities: options.capabilities ?? options.core?.capabilities,
	});
	const projects = createProjectsApi(core);
	const instances = createInstancesApi(core, options.instances);
	const generation = readGeneration();
	const isCurrent = () => readGeneration() === generation;

	let persistence: Persistence | null = null;
	let sync: TabSync | null = null;
	let wiped = false;
	let disposed = false;

	/** This tab's session data is gone (logout here or in another tab). */
	const onWiped = () => {
		if (wiped) return;
		wiped = true;
		persistence?.stop();
		persistence = null;
		sync?.stop();
		sync = null;
		core.clear();
	};

	const stopLocal = onWipe(onWiped);
	const stopRemote = listenForWipes((next) => {
		if (next !== generation) onWiped();
	});

	if (!isCurrent()) onWiped();

	const makeChannel =
		options.channel === undefined
			? typeof BroadcastChannel !== "undefined"
				? () =>
						new BroadcastChannel(
							channelName(options.sessionKey),
						) as unknown as ChannelLike
				: null
			: options.channel;
	if (makeChannel && !wiped) {
		sync = new TabSync(core, makeChannel(), { generation: readGeneration });
		sync.start();
	}

	const name = databaseName(options.sessionKey);
	const storage =
		options.storage ??
		(async () => {
			registerDatabase(name);
			return openIndexedDb(name);
		});
	const ready = storage()
		.then((backend) => {
			if (!backend) return;
			if (disposed || wiped || !isCurrent()) {
				backend.close();
				return;
			}
			persistence = new Persistence(core, backend, {
				isCurrent,
				onError: options.onPersistenceError,
			});
			return persistence.start();
		})
		.catch((error: unknown) => {
			// Unavailable storage never stops the in-memory layer.
			options.onPersistenceError?.(error);
		});

	return {
		core,
		projects,
		instances,
		operations: core.operations,
		/** Resolves once hydration finished (or storage turned out unavailable). */
		ready,
		/** Writes queued changes now (page hidden). */
		flush: () => persistence?.flush() ?? Promise.resolve(),
		/** The tab was suspended: events may have been missed. */
		resumed: () => {
			if (!isCurrent()) {
				onWiped();
				return;
			}
			core.resumed();
		},
		/** Logout cleanup for every tab, account and deployment (#1). */
		wipe: (): Promise<WipeResult> => wipeIncusData(),
		dispose() {
			disposed = true;
			stopLocal();
			stopRemote();
			const pending = persistence;
			persistence = null;
			void pending?.flush().finally(() => pending.stop());
			sync?.stop();
			core.dispose();
		},
	};
}

export type DataLayer = ReturnType<typeof createDataLayer>;
