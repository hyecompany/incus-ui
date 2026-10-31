// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import {
	ALL_PROJECTS,
	collectionMemberKey,
	type InstanceField,
	instanceIdentityFromUrl,
	ordinaryInstanceFields,
} from "./instances.ts";

export type FieldObservation<T> = {
	value: T;
	fresh: boolean;
	lifecycle: number;
};

export type InstanceObservations = {
	name?: FieldObservation<string>;
	status?: FieldObservation<string>;
	statusCode?: FieldObservation<number>;
	location?: FieldObservation<string>;
	type?: FieldObservation<string>;
	project?: FieldObservation<string>;
	architecture?: FieldObservation<string>;
	description?: FieldObservation<string>;
};

export type InstanceSnapshot = {
	deploymentId: string;
	project: string;
	name: string;
	lifecycle: number;
	fields: InstanceObservations;
};

export type CollectionError = {
	message: string;
	status: number;
};

export type CollectionSnapshot = {
	deploymentId: string;
	project: string;
	status: string | null;
	names: readonly string[];
	complete: boolean;
	fresh: boolean;
	fetching: boolean;
	error: CollectionError | null;
};

export type ReadToken = {
	readonly sessionGeneration: number;
	readonly lifecycles: ReadonlyMap<string, number>;
};

export type CollectionUpdate = {
	project: string;
	status: string | null;
	entries: readonly unknown[];
	representation: 0 | 1;
};

export type IncusStore = {
	readonly deploymentId: string;
	beginRead(project: string, names: readonly string[]): ReadToken;
	beginReadAll(): ReadToken;
	applyInstanceFields(
		token: ReadToken,
		project: string,
		record: object,
	): boolean;
	applyCollection(token: ReadToken, update: CollectionUpdate): boolean;
	noteCreated(project: string, name: string): void;
	markCollectionFetching(
		project: string,
		status: string | null,
		fetching: boolean,
	): void;
	setCollectionError(
		project: string,
		status: string | null,
		error: CollectionError | null,
	): void;
	invalidateAll(): void;
	deleteInstance(project: string, name: string): void;
	bumpSession(): void;
	subscribe(listener: () => void): () => void;
	getInstance(project: string, name: string): InstanceSnapshot | undefined;
	getCollection(project: string, status: string | null): CollectionSnapshot;
	instanceNames(project: string): string[];
	markCollectionFreshness(
		project: string,
		status: string | null,
		fresh: boolean,
	): void;
	invalidateFilteredCollections(project: string): void;
	drainDirty(): Array<{ project: string; name: string }>;
	inflight<T>(key: string, work: () => Promise<T>): Promise<T>;
	version(): number;
};

type Resource = {
	project: string;
	name: string;
	lifecycle: number;
	fields: InstanceObservations;
};

type CollectionState = {
	deploymentId: string;
	project: string;
	status: string | null;
	names: string[];
	complete: boolean;
	fresh: boolean;
	fetching: boolean;
	error: CollectionError | null;
};

const STRING_FIELDS = [
	"name",
	"status",
	"location",
	"type",
	"project",
	"architecture",
	"description",
] as const satisfies readonly Exclude<InstanceField, "statusCode">[];

function resourceKey(project: string, name: string): string {
	return `${project}\0${name}`;
}

function collectionKey(project: string, status: string | null): string {
	return status === null ? `all\0${project}` : `status\0${project}\0${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringObservation(
	value: string,
	lifecycle: number,
): FieldObservation<string> {
	return { value, fresh: true, lifecycle };
}

function statusCodeFromRecord(
	record: Record<string, unknown>,
): number | undefined {
	if ("status_code" in record) {
		return typeof record.status_code === "number"
			? record.status_code
			: undefined;
	}
	if ("statusCode" in record && typeof record.statusCode === "number") {
		return record.statusCode;
	}
	return undefined;
}

function writePresentFields(
	resource: Resource,
	record: Record<string, unknown>,
): void {
	for (const field of STRING_FIELDS) {
		const value = record[field];
		if (typeof value !== "string") continue;
		resource.fields[field] = stringObservation(value, resource.lifecycle);
	}
	const statusCode = statusCodeFromRecord(record);
	if (statusCode === undefined) return;
	resource.fields.statusCode = {
		value: statusCode,
		fresh: true,
		lifecycle: resource.lifecycle,
	};
}

function rememberIdentity(resource: Resource, project: string): void {
	resource.fields.name = stringObservation(resource.name, resource.lifecycle);
	resource.fields.project = stringObservation(project, resource.lifecycle);
}

function cloneFields(fields: InstanceObservations): InstanceObservations {
	const copy: InstanceObservations = {};
	if (fields.name) copy.name = { ...fields.name };
	if (fields.status) copy.status = { ...fields.status };
	if (fields.statusCode) copy.statusCode = { ...fields.statusCode };
	if (fields.location) copy.location = { ...fields.location };
	if (fields.type) copy.type = { ...fields.type };
	if (fields.project) copy.project = { ...fields.project };
	if (fields.architecture) copy.architecture = { ...fields.architecture };
	if (fields.description) copy.description = { ...fields.description };
	return copy;
}

function unknownCollection(
	deploymentId: string,
	project: string,
	status: string | null,
): CollectionSnapshot {
	return {
		deploymentId,
		project,
		status,
		names: [],
		complete: false,
		fresh: false,
		fetching: false,
		error: null,
	};
}

type ParsedEntry = {
	name: string;
	project: string;
	record: Record<string, unknown> | null;
};

function parseEntry(
	entry: unknown,
	representation: 0 | 1,
	project: string,
): ParsedEntry | null {
	if (representation === 0) {
		if (typeof entry !== "string" || entry.length === 0) return null;
		let identity: { name: string; project: string };
		try {
			identity = instanceIdentityFromUrl(entry);
		} catch {
			return null;
		}
		if (identity.name.length === 0) return null;
		if (project !== ALL_PROJECTS && identity.project !== project) return null;
		return {
			name: identity.name,
			project: project === ALL_PROJECTS ? identity.project : project,
			record: null,
		};
	}
	if (!isRecord(entry)) return null;
	if (typeof entry.name !== "string" || entry.name.length === 0) return null;
	const namedProject =
		typeof entry.project === "string" && entry.project.length > 0
			? entry.project
			: undefined;
	if (
		project !== ALL_PROJECTS &&
		namedProject !== undefined &&
		namedProject !== project
	) {
		return null;
	}
	return {
		name: entry.name,
		project: namedProject ?? (project === ALL_PROJECTS ? "default" : project),
		record: entry,
	};
}

export function createIncusStore(deploymentId = "local"): IncusStore {
	let sessionGeneration = 1;
	let currentVersion = 0;
	const resources = new Map<string, Resource>();
	const collections = new Map<string, CollectionState>();
	const flights = new Map<string, Promise<unknown>>();
	const listeners = new Set<() => void>();
	const dirty = new Set<string>();

	function touch(project: string, name: string): void {
		dirty.add(resourceKey(project, name));
	}

	function notify(): void {
		currentVersion += 1;
		for (const listener of [...listeners]) listener();
	}

	function createResource(project: string, name: string): Resource {
		return { project, name, lifecycle: 1, fields: {} };
	}

	function ensureCollection(
		project: string,
		status: string | null,
	): CollectionState {
		const key = collectionKey(project, status);
		const existing = collections.get(key);
		if (existing) return existing;
		const created: CollectionState = {
			deploymentId,
			project,
			status,
			names: [],
			complete: false,
			fresh: false,
			fetching: false,
			error: null,
		};
		collections.set(key, created);
		return created;
	}

	function beginRead(project: string, names: readonly string[]): ReadToken {
		const lifecycles = new Map<string, number>();
		for (const name of names) {
			lifecycles.set(
				resourceKey(project, name),
				resources.get(resourceKey(project, name))?.lifecycle ?? 0,
			);
		}
		return { sessionGeneration, lifecycles };
	}

	function beginReadAll(): ReadToken {
		const lifecycles = new Map<string, number>();
		for (const [key, resource] of resources) {
			lifecycles.set(key, resource.lifecycle);
		}
		return { sessionGeneration, lifecycles };
	}

	function applyInstanceFields(
		token: ReadToken,
		project: string,
		record: object,
	): boolean {
		if (token.sessionGeneration !== sessionGeneration) return false;
		if (!isRecord(record)) return false;
		if (typeof record.name !== "string" || record.name.length === 0) {
			return false;
		}
		const key = resourceKey(project, record.name);
		const existing = resources.get(key);
		const expected = token.lifecycles.get(key) ?? 0;
		if (expected !== (existing?.lifecycle ?? 0)) return false;
		const resource = existing ?? createResource(project, record.name);
		if (!existing) resources.set(key, resource);
		writePresentFields(resource, record);
		touch(project, record.name);
		notify();
		return true;
	}

	function applyCollection(
		token: ReadToken,
		update: CollectionUpdate,
	): boolean {
		if (token.sessionGeneration !== sessionGeneration) return false;
		const names: string[] = [];
		const seen = new Set<string>();
		for (const entry of update.entries) {
			const parsed = parseEntry(entry, update.representation, update.project);
			if (!parsed) continue;
			const member = collectionMemberKey(
				update.project,
				parsed.project,
				parsed.name,
			);
			const key = resourceKey(parsed.project, parsed.name);
			const existing = resources.get(key);
			const expected = token.lifecycles.get(key) ?? 0;
			if (expected !== (existing?.lifecycle ?? 0)) {
				if (existing?.fields.name && !seen.has(member)) {
					seen.add(member);
					names.push(member);
				}
				continue;
			}
			const resource = existing ?? createResource(parsed.project, parsed.name);
			if (!existing) resources.set(key, resource);
			if (parsed.record) writePresentFields(resource, parsed.record);
			rememberIdentity(resource, parsed.project);
			touch(parsed.project, parsed.name);
			if (seen.has(member)) continue;
			seen.add(member);
			names.push(member);
		}
		const collection = ensureCollection(update.project, update.status);
		collection.names = names;
		collection.complete = true;
		collection.fresh = true;
		collection.fetching = false;
		collection.error = null;
		notify();
		return true;
	}

	function noteCreated(project: string, name: string): void {
		const key = resourceKey(project, name);
		const existing = resources.get(key);
		if (!existing) {
			const resource = createResource(project, name);
			rememberIdentity(resource, project);
			resources.set(key, resource);
			touch(project, name);
			notify();
			return;
		}
		let changed = false;
		if (!existing.fields.name) {
			existing.fields.name = stringObservation(
				existing.name,
				existing.lifecycle,
			);
			changed = true;
		}
		if (!existing.fields.project) {
			existing.fields.project = stringObservation(project, existing.lifecycle);
			changed = true;
		}
		if (changed) {
			touch(project, name);
			notify();
		}
	}

	function markCollectionFetching(
		project: string,
		status: string | null,
		fetching: boolean,
	): void {
		const key = collectionKey(project, status);
		const previous = collections.get(key)?.fetching ?? false;
		const collection = ensureCollection(project, status);
		collection.fetching = fetching;
		if (previous !== fetching) notify();
	}

	function setCollectionError(
		project: string,
		status: string | null,
		error: CollectionError | null,
	): void {
		const collection = ensureCollection(project, status);
		collection.error = error
			? { message: error.message, status: error.status }
			: null;
		collection.fresh = false;
		notify();
	}

	function invalidateAll(): void {
		for (const resource of resources.values()) {
			for (const field of ordinaryInstanceFields) {
				const observation = resource.fields[field];
				if (observation) observation.fresh = false;
			}
		}
		for (const collection of collections.values()) {
			collection.fresh = false;
			collection.error = null;
		}
		notify();
	}

	function deleteInstance(project: string, name: string): void {
		const resource = resources.get(resourceKey(project, name));
		if (!resource) return;
		resource.lifecycle += 1;
		resource.fields = {};
		touch(project, name);
		const encoded = collectionMemberKey(ALL_PROJECTS, project, name);
		for (const collection of collections.values()) {
			const drop =
				collection.project === project
					? name
					: collection.project === ALL_PROJECTS
						? encoded
						: null;
			if (!drop) continue;
			const next = collection.names.filter((entry) => entry !== drop);
			if (next.length !== collection.names.length) collection.names = next;
		}
		notify();
	}

	function bumpSession(): void {
		sessionGeneration += 1;
		resources.clear();
		collections.clear();
		flights.clear();
		dirty.clear();
		notify();
	}

	function subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}

	function getInstance(
		project: string,
		name: string,
	): InstanceSnapshot | undefined {
		const resource = resources.get(resourceKey(project, name));
		if (!resource) return undefined;
		return {
			deploymentId,
			project: resource.project,
			name: resource.name,
			lifecycle: resource.lifecycle,
			fields: cloneFields(resource.fields),
		};
	}

	function getCollection(
		project: string,
		status: string | null,
	): CollectionSnapshot {
		const collection = collections.get(collectionKey(project, status));
		if (!collection) return unknownCollection(deploymentId, project, status);
		return {
			deploymentId: collection.deploymentId,
			project: collection.project,
			status: collection.status,
			names: [...collection.names],
			complete: collection.complete,
			fresh: collection.fresh,
			fetching: collection.fetching,
			error: collection.error ? { ...collection.error } : null,
		};
	}

	function instanceNames(project: string): string[] {
		const names: string[] = [];
		for (const resource of resources.values()) {
			if (resource.project === project && resource.fields.name) {
				names.push(resource.name);
			}
		}
		return names;
	}

	function markCollectionFreshness(
		project: string,
		status: string | null,
		fresh: boolean,
	): void {
		const collection = collections.get(collectionKey(project, status));
		if (!collection || collection.fresh === fresh) return;
		collection.fresh = fresh;
		if (!fresh) collection.error = null;
		notify();
	}

	function invalidateFilteredCollections(project: string): void {
		let changed = false;
		for (const collection of collections.values()) {
			if (collection.project !== project || collection.status === null)
				continue;
			if (!collection.fresh && !collection.error) continue;
			collection.fresh = false;
			collection.error = null;
			changed = true;
		}
		if (changed) notify();
	}

	function drainDirty(): Array<{ project: string; name: string }> {
		const changes: Array<{ project: string; name: string }> = [];
		for (const key of dirty) {
			const separator = key.indexOf("\0");
			changes.push({
				project: key.slice(0, separator),
				name: key.slice(separator + 1),
			});
		}
		dirty.clear();
		return changes;
	}

	function inflight<T>(key: string, work: () => Promise<T>): Promise<T> {
		const existing = flights.get(key);
		if (existing) return existing as Promise<T>;
		const promise = new Promise<T>((resolve, reject) => {
			try {
				resolve(work());
			} catch (error) {
				reject(error);
			}
		}).finally(() => {
			if (flights.get(key) === promise) flights.delete(key);
		});
		flights.set(key, promise);
		return promise;
	}

	function version(): number {
		return currentVersion;
	}

	return {
		deploymentId,
		beginRead,
		beginReadAll,
		applyInstanceFields,
		applyCollection,
		noteCreated,
		markCollectionFetching,
		setCollectionError,
		invalidateAll,
		deleteInstance,
		bumpSession,
		subscribe,
		getInstance,
		getCollection,
		instanceNames,
		markCollectionFreshness,
		invalidateFilteredCollections,
		drainDirty,
		inflight,
		version,
	};
}

export const incusStore = createIncusStore();
