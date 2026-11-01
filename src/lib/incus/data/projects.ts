// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { IncusEvent } from "../events/types.ts";
import {
	fetchProject,
	fetchProjectNames,
	fetchProjectObjects,
	type Project,
	type ProjectDetails,
	type ProjectField,
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
import type { Validation } from "./store.ts";

const COLLECTION = "projects";
const DETAILS = "details";
const PREFIX = "project\0";
/** Above this many single-project fetches, one recursive list is cheaper. */
const MAX_INDIVIDUAL = 2;

export const projectKey = (name: string) => `${PREFIX}${name}`;

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

const wantsDetails = (need: ProjectsNeed) =>
	need.fields.some((f) => f !== "name");

function pick(
	name: string,
	details: Readonly<Record<string, unknown>> | undefined,
	fields: readonly ProjectField[],
): Partial<Project> {
	const row: Record<string, unknown> = {};
	for (const field of fields) {
		row[field] = field === "name" ? name : details?.[field];
	}
	return row as Partial<Project>;
}

/* ---------------------------------------------------------------- reading */

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
	const details = wantsDetails(need);
	const rows: Partial<Project>[] = [];
	const missing: string[] = [];
	let fresh = !collection.invalid && ctx.isFresh(collection.validation);
	let stale = collection.invalid || ctx.shouldValidate(collection.validation);
	for (const name of [...collection.members].sort()) {
		const group = ctx.store.record(projectKey(name))?.groups.get(DETAILS);
		if (details && !group) {
			missing.push(name);
			fresh = false;
			continue;
		}
		if (details && group) {
			if (group.invalid || !ctx.isFresh(group.validation)) fresh = false;
			if (group.invalid || ctx.shouldValidate(group.validation)) stale = true;
		}
		rows.push(pick(name, group?.values, need.fields));
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
			row: exists ? pick(need.name, undefined, need.fields) : undefined,
			available: true,
			fresh: existenceFresh,
			stale: existenceStale,
		};
	}
	const group = record?.groups.get(DETAILS);
	if (!group) {
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
		row: pick(need.name, group.values, need.fields),
		available: true,
		fresh: existenceFresh && !group.invalid && ctx.isFresh(group.validation),
		stale:
			existenceStale || group.invalid || ctx.shouldValidate(group.validation),
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

function applyDetails(ctx: DataContext, project: ProjectObject, v: Validation) {
	const key = projectKey(project.name);
	const existing = ctx.store.record(key)?.groups.get(DETAILS);
	// No server revision: prefer the later-sent of two overlapping reads.
	if (existing && !existing.invalid && existing.validation.at > v.at) return;
	ctx.store.setGroup(
		key,
		DETAILS,
		{ description: project.description, config: project.config },
		v,
	);
}

function listNamesRequest(): PlannedRequest<ProjectsNeed> {
	return {
		key: "GET /1.0/projects",
		covers: (need) => !wantsDetails(need),
		async run(signal) {
			const names = await fetchProjectNames({ signal });
			return (ctx, v) => applyMembership(ctx, names, v);
		},
	};
}

function listObjectsRequest(): PlannedRequest<ProjectsNeed> {
	return {
		key: "GET /1.0/projects?recursion=1",
		covers: () => true,
		async run(signal) {
			const projects = await fetchProjectObjects({ signal });
			return (ctx, v) => {
				applyMembership(
					ctx,
					projects.map((p) => p.name),
					v,
				);
				for (const project of projects) applyDetails(ctx, project, v);
			};
		},
	};
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
			const project = await fetchProject(name, { signal });
			return (c, v) => {
				const key = projectKey(name);
				if (project === null) {
					c.store.markAbsent(key, v);
					c.store.removeMember(COLLECTION, name);
					return;
				}
				c.store.markExists(key, v);
				c.store.addMember(COLLECTION, name);
				applyDetails(c, project, v);
			};
		},
	};
}

/** Members of the list whose details must be fetched (membership is fine). */
function detailTargets(ctx: DataContext): string[] {
	const collection = ctx.store.collection(COLLECTION);
	if (!collection) return [];
	return [...collection.members].filter((name) => {
		const group = ctx.store.record(projectKey(name))?.groups.get(DETAILS);
		return !group || group.invalid || ctx.shouldValidate(group.validation);
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

export const projectsDefinition: ResourceDefinition<ProjectsNeed> = {
	name: "projects",

	applyEvent(event: IncusEvent, ctx: DataContext) {
		const change = parseResourceChange(event);
		if (!change || change.collection !== "projects" || !change.name) return;
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
				const oldKey = projectKey(oldName);
				const alreadyApplied =
					ctx.store.record(key)?.exists === true &&
					ctx.store.record(oldKey)?.exists === false;
				if (!alreadyApplied) {
					ctx.store.restart(key, v);
					ctx.store.copyGroups(oldKey, key);
					ctx.store.markAbsent(oldKey, v);
				}
				ctx.store.removeMember(COLLECTION, oldName);
				ctx.store.addMember(COLLECTION, name);
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
				for (const name of detailTargets(ctx)) details.add(name);
			}
		}
		if (full || details.size > MAX_INDIVIDUAL) return [listObjectsRequest()];

		const requests: PlannedRequest<ProjectsNeed>[] = [];
		for (const name of details) requests.push(oneRequest(name, ctx));
		const onlyExistence = [...existence].filter((name) => !details.has(name));
		// The URL list answers existence for every project in one small request.
		if (names || onlyExistence.length > MAX_INDIVIDUAL) {
			requests.push(listNamesRequest());
		} else {
			for (const name of onlyExistence) requests.push(oneRequest(name, ctx));
		}
		return requests;
	},
};

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
			fetching: core.isFetching(need),
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
			fetching: core.isFetching(need),
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
	};
}

export type ProjectsApi = ReturnType<typeof createProjectsApi>;

export type { CollectionResult, ResourceResult, Watch };
