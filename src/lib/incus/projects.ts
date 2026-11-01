// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { projectPath } from "./internal/paths.ts";
import { READ_POLICY, toIncusError, withRetry } from "./internal/request.ts";
import { isRecord, readString } from "./internal/values.ts";
import type { DataResult } from "./result.ts";
import {
	type IncusRequestError,
	incusPath,
	incusRequest,
} from "./transport.ts";

export type Project = { name: string; description: string };
export type ProjectField = keyof Project;

export function projectCollectionRequest(fields: readonly ProjectField[]): {
	path: string;
	representation: 0 | 1;
} {
	const representation = fields.every((field) => field === "name") ? 0 : 1;
	return {
		path: incusPath("/1.0/projects", {
			recursion: representation === 0 ? undefined : "1",
		}),
		representation,
	};
}

export function projectIdentityFromUrl(url: string): { name: string } {
	const parsed = new URL(url, "https://incus.local");
	const name = decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "");
	return { name };
}

export function projectFromObject(record: Record<string, unknown>): Project {
	return {
		name: readString(record, "name") ?? "",
		description: readString(record, "description") ?? "",
	};
}

type ProjectEntry = {
	name: string;
	description?: string;
};

let cacheVersion = 0;
const listeners = new Set<() => void>();
const records = new Map<string, ProjectEntry>();
let orderedNames: string[] = [];
let collectionNamesComplete = false;
let collectionDescriptionsComplete = false;
let collectionFresh = false;
let collectionFetching = false;
let collectionError: IncusRequestError | null = null;

const inFlight = new Map<string, Promise<void>>();
const pathFailures = new Map<string, IncusRequestError>();
const projectFailures = new Map<string, IncusRequestError>();
const projectErrors = new Map<string, IncusRequestError>();

function notify(): void {
	cacheVersion += 1;
	for (const listener of [...listeners]) listener();
}

export function subscribeProjects(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function projectsSnapshot(): number {
	return cacheVersion;
}

function recomputeDescriptionsComplete(): void {
	collectionDescriptionsComplete = orderedNames.every(
		(name) => records.get(name)?.description !== undefined,
	);
}

function applyNameOnlyCollection(metadata: unknown): void {
	if (!Array.isArray(metadata)) {
		throw new Error("Project collection metadata was not a list");
	}
	const nextNames: string[] = [];
	for (const entry of metadata) {
		if (typeof entry !== "string") {
			throw new Error("Project collection entry was not a URL");
		}
		const identity = projectIdentityFromUrl(entry);
		nextNames.push(identity.name);
		const existing = records.get(identity.name);
		if (existing) {
			existing.name = identity.name;
		} else {
			records.set(identity.name, { name: identity.name });
		}
	}
	for (const name of [...records.keys()]) {
		if (!nextNames.includes(name)) records.delete(name);
	}
	orderedNames = nextNames;
	collectionNamesComplete = true;
	collectionFresh = true;
	collectionError = null;
	recomputeDescriptionsComplete();
}

function applyRecursionCollection(metadata: unknown): void {
	if (!Array.isArray(metadata)) {
		throw new Error("Project collection metadata was not a list");
	}
	const nextNames: string[] = [];
	for (const entry of metadata) {
		if (!isRecord(entry)) {
			throw new Error("Project collection entry was not an object");
		}
		const project = projectFromObject(entry);
		nextNames.push(project.name);
		records.set(project.name, {
			name: project.name,
			description: project.description,
		});
	}
	for (const name of [...records.keys()]) {
		if (!nextNames.includes(name)) records.delete(name);
	}
	orderedNames = nextNames;
	collectionNamesComplete = true;
	collectionDescriptionsComplete = true;
	collectionFresh = true;
	collectionError = null;
}

function markCollectionFailed(representation: 0 | 1): void {
	collectionFresh = false;
	if (representation === 0) collectionNamesComplete = false;
	else collectionDescriptionsComplete = false;
}

async function ensureCollectionPath(
	path: string,
	representation: 0 | 1,
): Promise<void> {
	if (pathFailures.has(path)) return;

	const existing = inFlight.get(path);
	if (existing) {
		await existing;
		return;
	}

	const promise = (async () => {
		collectionFetching = true;
		notify();
		try {
			const response = await withRetry(
				() => incusRequest<unknown>(path),
				READ_POLICY,
			);
			if (representation === 0) {
				applyNameOnlyCollection(response.metadata);
			} else {
				applyRecursionCollection(response.metadata);
			}
			pathFailures.delete(path);
		} catch (error) {
			const incusError = toIncusError(error);
			collectionError = incusError;
			markCollectionFailed(representation);
			if (incusError.status >= 400 && incusError.status < 500) {
				pathFailures.set(path, incusError);
			}
		} finally {
			collectionFetching = false;
			inFlight.delete(path);
			notify();
		}
	})();

	inFlight.set(path, promise);
	await promise;
}

function pickProject<K extends ProjectField>(
	entry: ProjectEntry,
	fields: readonly K[],
): { row: Pick<Project, K> | null; ready: boolean } {
	const pick = {} as Pick<Project, K>;
	const writable = pick as unknown as Project;
	let ready = true;
	for (const field of fields) {
		if (field === "name") {
			writable.name = entry.name;
			continue;
		}
		if (entry.description === undefined) {
			ready = false;
			continue;
		}
		writable.description = entry.description;
	}
	return { row: ready ? pick : null, ready };
}

function collectionFieldsComplete(fields: readonly ProjectField[]): boolean {
	if (!collectionNamesComplete) return false;
	if (fields.every((field) => field === "name")) return true;
	return collectionDescriptionsComplete;
}

export function readProjects<K extends ProjectField>(
	fields: readonly K[],
): DataResult<Array<Pick<Project, K>>> {
	const rows: Array<Pick<Project, K>> = [];
	let fieldsReady = true;
	for (const name of orderedNames) {
		const entry = records.get(name);
		if (!entry) {
			fieldsReady = false;
			continue;
		}
		const picked = pickProject(entry, fields);
		if (!picked.ready) fieldsReady = false;
		else if (picked.row) rows.push(picked.row);
	}
	const membershipReady = collectionFieldsComplete(fields);
	const settled = membershipReady && fieldsReady && !collectionError;
	const show = collectionNamesComplete || rows.length > 0;
	return {
		data: show ? rows : undefined,
		available: show,
		complete: settled,
		fresh: settled && collectionFresh && !collectionFetching,
		fetching: collectionFetching,
		error: collectionError,
	};
}

export async function ensureProjects(
	fields: readonly ProjectField[],
): Promise<void> {
	const request = projectCollectionRequest(fields);
	if (pathFailures.has(request.path) || collectionError) return;
	if (
		collectionFresh &&
		!collectionFetching &&
		collectionFieldsComplete(fields)
	) {
		return;
	}
	await ensureCollectionPath(request.path, request.representation);
}

async function ensureProjectFetch(name: string): Promise<void> {
	if (projectFailures.has(name)) return;

	const path = projectPath(name);
	const existing = inFlight.get(path);
	if (existing) {
		await existing;
		return;
	}

	const promise = (async () => {
		notify();
		try {
			const response = await withRetry(
				() => incusRequest<unknown>(path),
				READ_POLICY,
			);
			if (!isRecord(response.metadata)) {
				throw new Error("Project metadata was not an object");
			}
			const project = projectFromObject(response.metadata);
			records.set(project.name, {
				name: project.name,
				description: project.description,
			});
			if (!orderedNames.includes(project.name)) {
				orderedNames = [...orderedNames, project.name];
			}
			projectErrors.delete(name);
			projectFailures.delete(name);
			recomputeDescriptionsComplete();
		} catch (error) {
			const incusError = toIncusError(error);
			projectErrors.set(name, incusError);
			if (incusError.status >= 400 && incusError.status < 500) {
				projectFailures.set(name, incusError);
			}
		} finally {
			inFlight.delete(path);
			notify();
		}
	})();

	inFlight.set(path, promise);
	await promise;
}

export function readProject<K extends ProjectField>(
	name: string,
	fields: readonly K[],
): DataResult<Pick<Project, K>> {
	const failure = projectErrors.get(name);
	const entry = records.get(name);
	const pick = {} as Pick<Project, K>;
	let ready = true;
	if (entry) {
		const picked = pickProject(entry, fields);
		ready = picked.ready;
		if (picked.row) {
			for (const field of fields) {
				pick[field] = picked.row[field];
			}
		}
	} else {
		ready = false;
	}
	const error = failure ?? null;
	return {
		data: ready ? pick : undefined,
		available: ready,
		complete: ready && !error,
		fresh: ready && !error,
		fetching: false,
		error,
	};
}

export async function ensureProject(
	name: string,
	fields: readonly ProjectField[],
): Promise<void> {
	const needsDescription = fields.some((field) => field !== "name");
	const entry = records.get(name);
	if (
		entry &&
		entry.name.length > 0 &&
		(!needsDescription || entry.description !== undefined)
	) {
		return;
	}
	await ensureProjectFetch(name);
}

export function resetProjectsForTests(): void {
	records.clear();
	orderedNames = [];
	collectionNamesComplete = false;
	collectionDescriptionsComplete = false;
	collectionFresh = false;
	collectionFetching = false;
	collectionError = null;
	inFlight.clear();
	pathFailures.clear();
	projectFailures.clear();
	projectErrors.clear();
	cacheVersion = 0;
	listeners.clear();
}
