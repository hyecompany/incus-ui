// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { supports, unsupported } from "../capabilities.ts";
import { IncusApiError, type IncusOperationRef } from "../client.ts";
import type { IncusEvent } from "../events/types.ts";
import { instanceIdentityFromUrl } from "../instances.ts";
import {
	createProject,
	deleteProject,
	fetchProjectNames,
	fetchProjectObjects,
	fetchProjectWithEtag,
	type Project,
	type ProjectDetails,
	type ProjectField,
	type ProjectPut,
	putProject,
	renameProject,
} from "../projects.ts";
import { parseResourceChange } from "../resource-events.ts";
import {
	type CollectionResult,
	type ResourceResult,
	settle,
	type Watch,
	watch,
} from "./consumers.ts";
import type {
	DataContext,
	DataCore,
	Need,
	PlannedRequest,
	ResourceDefinition,
} from "./core.ts";
import { observeInstanceExists } from "./instances.ts";
import type { OperationHandle } from "./operations.ts";
import type { FieldGroup, Validation } from "./store.ts";

const COLLECTION = "projects";
const DETAILS = "details";
/** `used_by` changes with every resource created in the project: its own group. */
const USED_BY = "used-by";
const PREFIX = "project\0";
/** Relationship kind: project -> the resources its `used_by` lists. */
export const USED_BY_RELATION = "used-by";
/** Above this many single-project fetches, one recursive list is cheaper. */
const MAX_INDIVIDUAL = 2;

export const projectKey = (name: string) => `${PREFIX}${name}`;

const GROUP_OF: Record<ProjectField, string | null> = {
	name: null,
	description: DETAILS,
	config: DETAILS,
	usedBy: USED_BY,
};

/** Project config keys known to carry no secrets. */
const SAFE_CONFIG_PREFIXES = [
	"features.",
	"limits.",
	"restricted",
	"backups.",
	"images.",
];

function persistGroup(
	group: string,
	values: Readonly<Record<string, unknown>>,
): boolean {
	if (group === USED_BY) return true;
	if (group !== DETAILS) return false;
	const config = values.config;
	return (
		typeof config === "object" &&
		config !== null &&
		Object.keys(config).every((key) =>
			SAFE_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix)),
		)
	);
}

export interface ProjectListNeed extends Need {
	kind: "list";
	fields: readonly ProjectField[];
}

export interface ProjectNeed extends Need {
	kind: "one";
	name: string;
	fields: readonly ProjectField[];
}

export type ProjectsNeed = ProjectListNeed | ProjectNeed;

const normalize = (fields: readonly ProjectField[]) =>
	[...new Set<ProjectField>(["name", ...fields])].sort();

export function projectListNeed(
	fields: readonly ProjectField[],
): ProjectListNeed {
	const normal = normalize(fields);
	return {
		key: `projects/list/${normal.join(",")}`,
		kind: "list",
		fields: normal,
	};
}

export function projectNeed(
	name: string,
	fields: readonly ProjectField[],
): ProjectNeed {
	const normal = normalize(fields);
	return {
		key: `projects/one/${encodeURIComponent(name)}/${normal.join(",")}`,
		kind: "one",
		name,
		fields: normal,
	};
}

const groupsFor = (fields: readonly ProjectField[]) => [
	...new Set(
		fields.map((f) => GROUP_OF[f]).filter((g): g is string => g !== null),
	),
];

const wantsDetails = (need: ProjectsNeed) => groupsFor(need.fields).length > 0;

function pick(
	name: string,
	values: Readonly<Record<string, unknown>>,
	fields: readonly ProjectField[],
): Partial<Project> {
	const row: Record<string, unknown> = {};
	for (const field of fields) {
		row[field] = field === "name" ? name : values[field];
	}
	return row as Partial<Project>;
}

/* ---------------------------------------------------------------- reading */

/** The selected groups of one project, or null if any is unknown. */
function readGroups(name: string, need: ProjectsNeed, ctx: DataContext) {
	const record = ctx.store.record(projectKey(name));
	const values: Record<string, unknown> = {};
	let fresh = true;
	let stale = false;
	for (const group of groupsFor(need.fields)) {
		const found: FieldGroup | undefined = record?.groups.get(group);
		if (!found) return null;
		Object.assign(values, found.values);
		if (found.invalid || !ctx.isFresh(found.validation)) fresh = false;
		if (found.invalid || ctx.shouldValidate(found.validation)) stale = true;
	}
	return { values, fresh, stale };
}

interface ListState {
	rows: Partial<Project>[] | undefined;
	missing: string[];
	complete: boolean;
	fresh: boolean;
	/** Some stored fact this need relies on should be (re)validated. */
	stale: boolean;
}

function readList(need: ProjectListNeed, ctx: DataContext): ListState {
	const collection = ctx.store.collection(COLLECTION);
	if (!collection) {
		return {
			rows: undefined,
			missing: [],
			complete: false,
			fresh: false,
			stale: true,
		};
	}
	const rows: Partial<Project>[] = [];
	const missing: string[] = [];
	let fresh = !collection.invalid && ctx.isFresh(collection.validation);
	let stale = collection.invalid || ctx.shouldValidate(collection.validation);
	for (const name of [...collection.members].sort()) {
		const groups = readGroups(name, need, ctx);
		if (!groups) {
			missing.push(name);
			fresh = false;
			continue;
		}
		if (!groups.fresh) fresh = false;
		if (groups.stale) stale = true;
		rows.push(pick(name, groups.values, need.fields));
	}
	return { rows, missing, complete: collection.complete, fresh, stale };
}

interface OneState {
	exists: boolean | undefined;
	row: Partial<Project> | undefined;
	available: boolean;
	fresh: boolean;
	stale: boolean;
}

function readOne(need: ProjectNeed, ctx: DataContext): OneState {
	const record = ctx.store.record(projectKey(need.name));
	let exists = record?.exists;
	let existence: Validation | undefined = record?.existence;
	if (exists === undefined) {
		// Derived fact: complete membership establishes existence or absence.
		const collection = ctx.store.collection(COLLECTION);
		if (collection?.complete && !collection.invalid) {
			exists = collection.members.has(need.name);
			existence = collection.validation;
		}
	}
	if (exists === undefined) {
		return {
			exists,
			row: undefined,
			available: false,
			fresh: false,
			stale: true,
		};
	}
	const existenceFresh = ctx.isFresh(existence);
	const existenceStale = ctx.shouldValidate(existence);
	if (!exists || !wantsDetails(need)) {
		return {
			exists,
			row: exists ? pick(need.name, {}, need.fields) : undefined,
			available: true,
			fresh: existenceFresh,
			stale: existenceStale,
		};
	}
	const groups = readGroups(need.name, need, ctx);
	if (!groups) {
		return {
			exists,
			row: undefined,
			available: false,
			fresh: false,
			stale: true,
		};
	}
	return {
		exists,
		row: pick(need.name, groups.values, need.fields),
		available: true,
		fresh: existenceFresh && groups.fresh,
		stale: existenceStale || groups.stale,
	};
}

/* ------------------------------------------------------------- reconciling */

type ProjectObject = { name: string } & ProjectDetails;

function applyMembership(
	ctx: DataContext,
	names: readonly string[],
	v: Validation,
) {
	const present = new Set(names);
	for (const name of names) ctx.store.markExists(projectKey(name), v);
	// A complete list establishes that every other project is absent here.
	for (const record of ctx.store.recordsWithPrefix(PREFIX)) {
		const name = record.key.slice(PREFIX.length);
		if (record.exists === true && !present.has(name)) {
			ctx.store.markAbsent(record.key, v);
		}
	}
	ctx.store.setCollection(COLLECTION, names, true, v);
}

/** Key a `used_by` URL refers to. Instances map to their shared identity. */
function usedByTarget(
	ctx: DataContext,
	project: string,
	url: string,
	v: Validation,
): string {
	if (url.startsWith("/1.0/instances/")) {
		try {
			const id = instanceIdentityFromUrl(url, {
				kind: "project",
				name: project,
			});
			// The response establishes the instance exists (and nothing else about it).
			return observeInstanceExists(ctx, id, v);
		} catch {
			// Not an instance URL we understand: keep it as an opaque reference.
		}
	}
	return `url\0${url}`;
}

function applyDetails(ctx: DataContext, project: ProjectObject, v: Validation) {
	const key = projectKey(project.name);
	const record = ctx.store.record(key);
	const latest = (group: string) => {
		const existing = record?.groups.get(group);
		// No server revision: prefer the later-sent of two overlapping reads.
		return !existing || existing.invalid || existing.validation.at <= v.at;
	};
	if (latest(DETAILS)) {
		ctx.store.setGroup(
			key,
			DETAILS,
			{ description: project.description, config: project.config },
			v,
		);
	}
	if (latest(USED_BY)) {
		ctx.store.setGroup(key, USED_BY, { usedBy: project.usedBy }, v);
		ctx.store.setRelation(
			key,
			USED_BY_RELATION,
			project.usedBy.map((url) => usedByTarget(ctx, project.name, url, v)),
			v,
		);
	}
}

function requireProjects(ctx: DataContext): void {
	if (!supports(ctx.capabilities, "projects")) {
		throw unsupported("projects", "Projects");
	}
}

function listNamesRequest(ctx: DataContext): PlannedRequest<ProjectsNeed> {
	return {
		key: "GET /1.0/projects",
		covers: (need) => !wantsDetails(need),
		async run(signal) {
			requireProjects(ctx);
			const names = await fetchProjectNames({ signal });
			return (c, v) => applyMembership(c, names, v);
		},
	};
}

function listObjectsRequest(ctx: DataContext): PlannedRequest<ProjectsNeed> {
	return {
		key: "GET /1.0/projects?recursion=1",
		covers: () => true,
		async run(signal) {
			requireProjects(ctx);
			const projects = await fetchProjectObjects({ signal });
			return (c, v) => {
				applyMembership(
					c,
					projects.map((p) => p.name),
					v,
				);
				for (const project of projects) applyDetails(c, project, v);
			};
		},
	};
}

function applyOne(
	c: DataContext,
	name: string,
	project: ProjectObject | null,
	v: Validation,
) {
	const key = projectKey(name);
	if (project === null) {
		c.store.markAbsent(key, v);
		c.store.removeMember(COLLECTION, name);
		return;
	}
	c.store.markExists(key, v);
	c.store.addMember(COLLECTION, name);
	applyDetails(c, project, v);
}

function oneRequest(
	name: string,
	ctx: DataContext,
): PlannedRequest<ProjectsNeed> {
	return {
		key: `GET /1.0/projects/${name}`,
		covers: (need) =>
			need.kind === "one"
				? need.name === name
				: wantsDetails(need) && readList(need, ctx).missing.includes(name),
		async run(signal) {
			requireProjects(ctx);
			const found = await fetchProjectWithEtag(name, { signal });
			return (c, v) => applyOne(c, name, found?.project ?? null, v);
		},
	};
}

/** Members of the list whose selected groups must be fetched (membership is fine). */
function detailTargets(need: ProjectListNeed, ctx: DataContext): string[] {
	const collection = ctx.store.collection(COLLECTION);
	if (!collection) return [];
	return [...collection.members].filter((name) => {
		const groups = readGroups(name, need, ctx);
		return !groups || groups.stale;
	});
}

function membershipStale(ctx: DataContext): boolean {
	const collection = ctx.store.collection(COLLECTION);
	return (
		!collection ||
		!collection.complete ||
		collection.invalid ||
		ctx.shouldValidate(collection.validation)
	);
}

/** Top-level resources whose creation or removal changes a project's `used_by`. */
const USED_BY_VERBS = new Set(["created", "deleted", "renamed"]);

export const projectsDefinition: ResourceDefinition<ProjectsNeed> = {
	name: "projects",

	applyEvent(event: IncusEvent, ctx: DataContext) {
		const change = parseResourceChange(event);
		if (!change || !change.name) return;
		if (change.collection !== "projects") {
			// Dependency: a project's used_by lists the resources inside it.
			if (USED_BY_VERBS.has(change.verb)) {
				ctx.store.invalidateGroup(
					projectKey(change.project ?? "default"),
					USED_BY,
				);
			}
			return;
		}
		if (change.path.split("/").filter(Boolean).length !== 3) return;
		const name = change.name;
		const key = projectKey(name);
		const v = ctx.eventValidation();
		switch (change.verb) {
			case "created":
				// A new lifecycle: nothing from an earlier project of this name.
				ctx.store.restart(key, v);
				ctx.store.addMember(COLLECTION, name);
				return;
			case "deleted":
				ctx.store.markAbsent(key, v);
				ctx.store.removeMember(COLLECTION, name);
				return;
			case "renamed": {
				const context = (event.metadata as { context?: { old_name?: unknown } })
					.context;
				const oldName =
					typeof context?.old_name === "string" ? context.old_name : null;
				if (!oldName) {
					ctx.store.invalidateCollection(COLLECTION);
					return;
				}
				applyRename(ctx, oldName, name, v);
				return;
			}
			case "updated":
				ctx.store.invalidateGroup(key, DETAILS);
				return;
		}
	},

	needsFetch(need, ctx) {
		if (need.kind === "list") {
			const state = readList(need, ctx);
			return !state.complete || state.missing.length > 0 || state.stale;
		}
		const state = readOne(need, ctx);
		return !state.available || state.stale;
	},

	plan(needs, ctx) {
		const details = new Set<string>();
		const existence = new Set<string>();
		let full = false;
		let names = false;
		for (const need of needs) {
			if (need.kind === "one") {
				(wantsDetails(need) ? details : existence).add(need.name);
			} else if (!wantsDetails(need)) {
				names = true;
			} else if (membershipStale(ctx)) {
				full = true;
			} else {
				for (const name of detailTargets(need, ctx)) details.add(name);
			}
		}
		if (full || details.size > MAX_INDIVIDUAL) return [listObjectsRequest(ctx)];

		const requests: PlannedRequest<ProjectsNeed>[] = [];
		for (const name of details) requests.push(oneRequest(name, ctx));
		const onlyExistence = [...existence].filter((name) => !details.has(name));
		// The URL list answers existence for every project in one small request.
		if (names || onlyExistence.length > MAX_INDIVIDUAL) {
			requests.push(listNamesRequest(ctx));
		} else {
			for (const name of onlyExistence) requests.push(oneRequest(name, ctx));
		}
		return requests;
	},

	persistence: {
		recordPrefix: PREFIX,
		group: persistGroup,
	},
};

function applyRename(
	ctx: DataContext,
	oldName: string,
	name: string,
	v: Validation,
) {
	const key = projectKey(name);
	const oldKey = projectKey(oldName);
	const alreadyApplied =
		ctx.store.record(key)?.exists === true &&
		ctx.store.record(oldKey)?.exists === false;
	if (!alreadyApplied) {
		ctx.store.restart(key, v);
		ctx.store.copyGroups(oldKey, key);
		// Resources inside it now have different identities.
		ctx.store.invalidateGroup(key, USED_BY);
		ctx.store.markAbsent(oldKey, v);
	}
	ctx.store.removeMember(COLLECTION, oldName);
	ctx.store.addMember(COLLECTION, name);
}

/* --------------------------------------------------------------- commands */

/** An edit in progress: the writable baseline and the ETag that validates it. */
export interface ProjectDraft {
	readonly name: string;
	readonly baseline: Readonly<ProjectPut>;
	readonly etag: string | null;
}

function commandError(cause: unknown): IncusApiError {
	if (cause instanceof IncusApiError && cause.kind !== "network") return cause;
	return new IncusApiError(
		"network",
		"The connection failed after sending; the command's outcome is unknown",
		{ cause },
	);
}

/* ------------------------------------------------------------- consumers */

type Selected<F extends readonly ProjectField[]> = Pick<
	Project,
	F[number] | "name"
>;

/** The projects surface: the same machinery for hooks and imperative code. */
export function createProjectsApi(core: DataCore) {
	core.register(projectsDefinition);

	const listResult = <F extends readonly ProjectField[]>(
		need: ProjectListNeed,
	): CollectionResult<Selected<F>> => {
		const state = readList(need, core.context);
		return {
			data: state.rows as Selected<F>[] | undefined,
			missing: state.missing,
			available: state.complete && state.missing.length === 0,
			complete: state.complete,
			fresh: state.fresh,
			fetching: core.isFetching(projectsDefinition, need),
			error: core.error(need.key),
		};
	};

	const oneResult = <F extends readonly ProjectField[]>(
		need: ProjectNeed,
	): ResourceResult<Selected<F>> => {
		const state = readOne(need, core.context);
		return {
			data: state.row as Selected<F> | undefined,
			exists: state.exists,
			available: state.available,
			fresh: state.fresh,
			fetching: core.isFetching(projectsDefinition, need),
			error: core.error(need.key),
		};
	};

	const watchList = <F extends readonly ProjectField[]>(
		fields: F,
	): Watch<CollectionResult<Selected<F>>> => {
		const need = projectListNeed(fields);
		return watch(core, projectsDefinition, need, () => listResult<F>(need));
	};

	const watchOne = <F extends readonly ProjectField[]>(
		name: string,
		fields: F,
	): Watch<ResourceResult<Selected<F>>> => {
		const need = projectNeed(name, fields);
		return watch(core, projectsDefinition, need, () => oneResult<F>(need));
	};

	/** Reads one project through the scheduler; returns its ETag. */
	let reads = 0;
	const readWithEtag = async (name: string) => {
		const generation = core.currentGeneration;
		let found: Awaited<ReturnType<typeof fetchProjectWithEtag>> = null;
		let failure: unknown = null;
		reads += 1;
		await core.read(projectsDefinition, {
			key: `read#${reads} project ${name}`,
			covers: () => false,
			async run(signal) {
				requireProjects(core.context);
				try {
					found = await fetchProjectWithEtag(name, { signal });
				} catch (cause) {
					failure = cause;
					throw cause;
				}
				const result = found;
				return (c, v) => applyOne(c, name, result?.project ?? null, v);
			},
		});
		if (failure) throw failure;
		if (!core.isCurrent(generation))
			throw new IncusApiError("aborted", "The data layer was cleared");
		return found as Awaited<ReturnType<typeof fetchProjectWithEtag>>;
	};

	/** Central invalidation after a write, then revalidation if cached. */
	const affected = (name: string) => {
		const key = projectKey(name);
		core.mutate((ctx) => {
			ctx.store.invalidateGroup(key, DETAILS);
			ctx.store.invalidateGroup(key, USED_BY);
		});
		if (!core.store.record(key)?.groups.size) return Promise.resolve();
		return readWithEtag(name).then(
			() => undefined,
			() => undefined,
		);
	};

	const observe = (work: (ctx: DataContext, v: Validation) => void) => {
		const v = core.context.eventValidation();
		core.mutate((ctx) => work(ctx, v));
	};

	return {
		watchList,
		watch: watchOne,
		list: <F extends readonly ProjectField[]>(fields: F) =>
			settle(watchList(fields)),
		get: <F extends readonly ProjectField[]>(name: string, fields: F) =>
			settle(watchOne(name, fields)),
		refreshList: (fields: readonly ProjectField[]) =>
			core.refresh(projectListNeed(fields).key),
		refresh: (name: string, fields: readonly ProjectField[]) =>
			core.refresh(projectNeed(name, fields).key),

		/** Reads the writable representation and its ETag for an edit. */
		async edit(name: string): Promise<ProjectDraft> {
			const found = await readWithEtag(name);
			if (!found)
				throw new IncusApiError("not-found", `Project "${name}" not found`, {
					status: 404,
				});
			return {
				name,
				baseline: {
					description: found.project.description,
					config: { ...found.project.config },
				},
				etag: found.etag,
			};
		},

		/** PUT conditional on the draft's ETag; 412 surfaces as a "conflict" error. */
		async save(
			draft: ProjectDraft,
			change: (baseline: ProjectPut) => ProjectPut,
		): Promise<void> {
			const body = change(structuredClone(draft.baseline) as ProjectPut);
			try {
				await putProject(draft.name, body, draft.etag);
			} catch (cause) {
				throw commandError(cause);
			}
			await affected(draft.name);
		},

		async create(
			project: { name: string } & Partial<ProjectPut>,
		): Promise<void> {
			try {
				await createProject(project);
			} catch (cause) {
				throw commandError(cause);
			}
			// Established: it exists. Its fields are still unknown.
			observe((ctx, v) => {
				ctx.store.markExists(projectKey(project.name), v);
				ctx.store.addMember(COLLECTION, project.name);
			});
		},

		async delete(name: string): Promise<void> {
			try {
				await deleteProject(name);
			} catch (cause) {
				throw commandError(cause);
			}
			observe((ctx, v) => {
				ctx.store.markAbsent(projectKey(name), v);
				ctx.store.removeMember(COLLECTION, name);
			});
		},

		async rename(
			name: string,
			newName: string,
		): Promise<{ operation: OperationHandle | null }> {
			let ref: IncusOperationRef | null;
			try {
				ref = await renameProject(name, newName);
			} catch (cause) {
				throw commandError(cause);
			}
			const done = () =>
				observe((ctx, v) => applyRename(ctx, name, newName, v));
			if (!ref) {
				done();
				return { operation: null };
			}
			const operation = core.operations.register(ref, {
				onDone: (record) => {
					if (record.status === "Success") done();
				},
			});
			return { operation };
		},
	};
}

export type ProjectsApi = ReturnType<typeof createProjectsApi>;

export type { CollectionResult, ResourceResult, Watch };
