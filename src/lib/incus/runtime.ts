// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { changeInstanceState, type InstanceStateAction } from "./commands.ts";
import { createEventStream, type IncusEvent } from "./event-stream.ts";
import {
	applyLifecycleEvent,
	markEventCoverage,
	parseEventMessage,
} from "./events.ts";
import {
	ALL_PROJECTS,
	collectionMemberIdentity,
	type Instance,
	type InstanceField,
	type InstanceQuery,
	instanceCollectionRequest,
	resolveProject,
} from "./instances.ts";
import { instancePath, operationPath } from "./internal/paths.ts";
import { READ_POLICY, toIncusError, withRetry } from "./internal/request.ts";
import {
	isRecord,
	readBoolean,
	readNumber,
	readString,
} from "./internal/values.ts";
import {
	createOperationRegistry,
	type OperationRegistry,
} from "./operations.ts";
import {
	applyRestoredInstances,
	createIndexedDbAdapter,
	createPersistenceQueue,
	type PersistedInstance,
	persistableInstance,
	persistedInstanceFromSnapshot,
	storeSessionGeneration,
} from "./persist.ts";
import { planInstanceCollection } from "./planner.ts";
import type { DataResult } from "./result.ts";
import { type IncusStore, incusStore } from "./store.ts";
import { createTabBridge, type TabBridge } from "./tabs.ts";
import { IncusRequestError, incusRequest } from "./transport.ts";

const listeners = new Set<() => void>();
const instanceErrors = new Map<string, { message: string; status: number }>();
let runtimeVersion = 0;
let bridge: TabBridge | null = null;
let persistence = createPersistenceQueue(createIndexedDbAdapter());

export const operationRegistry: OperationRegistry = createOperationRegistry();
const incusEvents = createEventStream();

function applyOperationEvent(event: IncusEvent): void {
	const id = readString(event.metadata, "id");
	if (!id) return;
	const next = {
		status: readString(event.metadata, "status") ?? "",
		statusCode: readNumber(event.metadata, "status_code") ?? 0,
		err: readString(event.metadata, "err") ?? "",
		mayCancel: readBoolean(event.metadata, "may_cancel") === true,
		monitoring: true,
	};
	const existing = operationRegistry.get(id);
	if (existing) {
		operationRegistry.update(id, next);
		return;
	}
	operationRegistry.register({
		id,
		url: operationPath(id),
		initiatedHere: false,
		...next,
	});
}

function applyIncomingEvent(store: IncusStore, event: IncusEvent): void {
	if (event.type === "operation") {
		applyOperationEvent(event);
		return;
	}
	if (event.type !== "lifecycle") return;
	const parsed = parseEventMessage(
		JSON.stringify({ type: "lifecycle", metadata: event.metadata }),
	);
	if (!parsed) return;
	applyLifecycleEvent(store, parsed);
	if (
		parsed.action === "instance-created" ||
		parsed.action === "instance-started" ||
		parsed.action === "instance-stopped" ||
		parsed.action === "instance-shutdown"
	) {
		store.invalidateFilteredCollections(parsed.project);
	}
}

function instanceErrorKey(project: string, name: string): string {
	return `${project}\0${name}`;
}

function notifyRuntime(): void {
	runtimeVersion += 1;
	for (const listener of [...listeners]) listener();
}

export function subscribeRuntime(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function runtimeSnapshot(): number {
	return runtimeVersion;
}

function collectionStatus(query: InstanceQuery): string | null {
	return query.status ? query.status : null;
}

function observationValue<K extends InstanceField>(
	instance: ReturnType<IncusStore["getInstance"]>,
	field: K,
): Instance[K] | undefined {
	const observation = instance?.fields[field];
	if (!observation) return undefined;
	return observation.value as Instance[K];
}

export function readInstances<K extends InstanceField>(
	store: IncusStore,
	fields: readonly K[],
	query: InstanceQuery = {},
): DataResult<Array<Pick<Instance, K>>> {
	const scope = instanceCollectionRequest(fields, query).project;
	const collection = store.getCollection(scope, collectionStatus(query));
	const rows: Array<Pick<Instance, K>> = [];
	let fieldsReady = true;
	let fieldsFresh = true;
	for (const stored of collection.names) {
		const identity = collectionMemberIdentity(scope, stored);
		const instance = store.getInstance(identity.project, identity.name);
		const pick = {} as Pick<Instance, K>;
		let rowReady = true;
		for (const field of fields) {
			const observation = instance?.fields[field];
			if (!observation) {
				rowReady = false;
				fieldsReady = false;
				continue;
			}
			if (!observation.fresh) fieldsFresh = false;
			pick[field] = observation.value as Pick<Instance, K>[typeof field];
		}
		if (rowReady) rows.push(pick);
	}
	const error = collection.error
		? new IncusRequestError(
				collection.error.message,
				collection.error.status,
				collection.error.status,
			)
		: null;
	const show = collection.complete || rows.length > 0;
	const settled = collection.complete && fieldsReady && !error;
	return {
		data: show ? rows : undefined,
		available: show,
		complete: settled,
		fresh: settled && fieldsFresh && collection.fresh && !collection.fetching,
		fetching: collection.fetching,
		error,
	};
}

export function readInstance<K extends InstanceField>(
	store: IncusStore,
	name: string,
	fields: readonly K[],
	query: { project?: string } = {},
): DataResult<Pick<Instance, K>> {
	const project = resolveProject(query.project);
	const instance = store.getInstance(project, name);
	const failure = instanceErrors.get(instanceErrorKey(project, name));
	const pick = {} as Pick<Instance, K>;
	let ready = true;
	let fresh = true;
	for (const field of fields) {
		const value = observationValue(instance, field);
		const observation = instance?.fields[field];
		if (value === undefined || !observation) {
			ready = false;
			continue;
		}
		if (!observation.fresh) fresh = false;
		pick[field] = value;
	}
	const error = failure
		? new IncusRequestError(failure.message, failure.status, failure.status)
		: null;
	return {
		data: ready ? pick : undefined,
		available: ready,
		complete: ready && !error,
		fresh: ready && fresh && !error,
		fetching: false,
		error,
	};
}

export async function ensureInstances(
	store: IncusStore,
	fields: readonly InstanceField[],
	query: InstanceQuery = {},
): Promise<void> {
	const project = instanceCollectionRequest(fields, query).project;
	const status = collectionStatus(query);
	if (store.getCollection(project, status).error) return;
	const plan = planInstanceCollection(store, fields, query);
	if (!plan) return;
	await store.inflight(`collection:${plan.path}`, async () => {
		const token =
			project === ALL_PROJECTS
				? store.beginReadAll()
				: store.beginRead(project, store.instanceNames(project));
		store.markCollectionFetching(project, status, true);
		try {
			const response = await withRetry(
				() => incusRequest<unknown>(plan.path),
				READ_POLICY,
			);
			if (!Array.isArray(response.metadata)) {
				throw new IncusRequestError(
					"Instance collection metadata was not a list",
					0,
					0,
				);
			}
			const applied = store.applyCollection(token, {
				project,
				status,
				representation: plan.representation,
				entries: response.metadata as unknown[],
			});
			if (!applied) store.markCollectionFetching(project, status, false);
			else incusEvents.noteReconciled();
		} catch (error) {
			const failure = toIncusError(error);
			store.markCollectionFetching(project, status, false);
			store.setCollectionError(project, status, {
				message: failure.message,
				status: failure.status,
			});
		}
	});
}

export async function ensureInstance(
	store: IncusStore,
	name: string,
	fields: readonly InstanceField[],
	query: { project?: string } = {},
): Promise<void> {
	const project = resolveProject(query.project);
	const key = instanceErrorKey(project, name);
	if (instanceErrors.has(key)) return;
	const current = readInstance(store, name, fields, query);
	if (current.fresh) return;
	const path = instancePath(project, name);
	await store.inflight(`instance:${path}`, async () => {
		const token = store.beginRead(project, [name]);
		try {
			const response = await withRetry(
				() => incusRequest<unknown>(path),
				READ_POLICY,
			);
			if (!isRecord(response.metadata)) {
				throw new IncusRequestError(
					"Instance metadata was not an object",
					0,
					0,
				);
			}
			const applied = store.applyInstanceFields(
				token,
				project,
				response.metadata,
			);
			if (applied) {
				instanceErrors.delete(key);
				notifyRuntime();
			}
		} catch (error) {
			const failure = toIncusError(error);
			instanceErrors.set(key, {
				message: failure.message,
				status: failure.status,
			});
			notifyRuntime();
		}
	});
}

function restoredFields(
	store: IncusStore,
	record: PersistedInstance,
): Record<string, unknown> {
	const current = store.getInstance(record.project, record.name);
	const fields: Record<string, unknown> = {
		name: record.name,
		project: record.project,
	};
	for (const [field, value] of Object.entries(record.fields)) {
		if (current?.fields[field as InstanceField]) continue;
		fields[field] = value;
	}
	return fields;
}

function publishSnapshots(records: PersistedInstance[]): void {
	if (!bridge || records.length === 0) return;
	bridge.publishInstances(records);
}

export function startIncusRuntime(store: IncusStore = incusStore): () => void {
	const adapter = createIndexedDbAdapter();
	persistence = createPersistenceQueue(adapter);
	const queue = persistence;
	let remote = false;
	let stopped = false;

	bridge = createTabBridge({
		sessionGeneration: () => storeSessionGeneration(store),
		onLogout: () => {
			incusEvents.stop();
			instanceErrors.clear();
			operationRegistry.clear();
			store.bumpSession();
			void queue.wipe();
		},
		onInstances: (records) => {
			remote = true;
			try {
				applyRestoredInstances(store, records, (target, ready) => {
					for (const record of ready) {
						if (record.sessionGeneration !== storeSessionGeneration(target))
							continue;
						const token = target.beginRead(record.project, [record.name]);
						target.applyInstanceFields(
							token,
							record.project,
							restoredFields(target, record),
						);
					}
				});
			} finally {
				remote = false;
			}
		},
	});

	const stopStore = store.subscribe(() => {
		const generation = storeSessionGeneration(store);
		const records: PersistedInstance[] = [];
		for (const change of store.drainDirty()) {
			const snapshot = store.getInstance(change.project, change.name);
			if (!snapshot?.fields.name) continue;
			const record = persistedInstanceFromSnapshot(snapshot, generation);
			record.fields = persistableInstance({ ...record.fields });
			queue.enqueue(record);
			records.push(record);
		}
		if (!remote) publishSnapshots(records);
	});

	const sessionAtRestore = storeSessionGeneration(store);
	void adapter.read(store.deploymentId).then(
		(records) => {
			if (stopped || storeSessionGeneration(store) !== sessionAtRestore) return;
			remote = true;
			try {
				applyRestoredInstances(store, records, (target, ready) => {
					for (const record of ready) {
						const token = target.beginRead(record.project, [record.name]);
						target.applyInstanceFields(
							token,
							record.project,
							restoredFields(target, record),
						);
					}
				});
			} finally {
				remote = false;
			}
		},
		() => {
			// Persistence is optional. The in-memory layer still fetches.
		},
	);

	let sawLiveEvents = false;
	const stopEventDelivery = incusEvents.subscribeDelivery(() => {
		const state = incusEvents.delivery();
		if (state === "live") sawLiveEvents = true;
		if (state === "interrupted" && sawLiveEvents) {
			markEventCoverage(store, false);
		}
	});
	const stopEventMessages = incusEvents.subscribe((event) => {
		applyIncomingEvent(store, event);
	});
	incusEvents.start();

	return () => {
		stopped = true;
		incusEvents.stop();
		stopEventDelivery();
		stopEventMessages();
		bridge?.close();
		bridge = null;
		stopStore();
	};
}

export async function logoutIncus(
	store: IncusStore = incusStore,
): Promise<{ deleted: boolean }> {
	bridge?.publishLogout();
	incusEvents.stop();
	instanceErrors.clear();
	operationRegistry.clear();
	store.bumpSession();
	notifyRuntime();
	return persistence.wipe();
}

export function changeInstance(
	name: string,
	action: InstanceStateAction,
	project?: string,
) {
	return changeInstanceState(name, action, {
		project,
		registry: operationRegistry,
	});
}
