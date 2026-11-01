// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { IncusEvent } from "../events/types.ts";
import {
	fetchInstance,
	fetchInstanceIdentities,
	fetchInstanceObjects,
	type Instance,
	type InstanceCriteria,
	type InstanceField,
	type InstanceIdentity,
	matchesCriteria,
} from "../instances.ts";
import {
	type ProjectScope,
	projectScopeKey,
	scopeFromKey,
} from "../project-scope.ts";
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
import type { CollectionRecord, Validation } from "./store.ts";

/*
 * Instances resource definition.
 *
 * Identity: deployment + access context (one DataCore per session) + project
 * + name. The location (cluster member) is a field, not part of identity.
 *
 * Collections are queries over /1.0/instances identified by their resolved
 * scope (one project, or all projects) and predicate (status). Membership is
 * tracked separately from fields, and a complete broader result answers a
 * narrower query locally when the fields it needs are known.
 *
 * Representations:
 *   GET /1.0/instances[?filter]              identities (URLs) only
 *   GET /1.0/instances?recursion=1[&filter]  ordinary objects
 *   GET /1.0/instances/{name}?project=       one ordinary object (404 = absent)
 * Field groups:
 *   status    status, statusCode (also changed directly by state events)
 *   ordinary  type, location, architecture, description, createdAt,
 *             lastUsedAt, profiles
 *
 * Events (lifecycle, all projects):
 *   created                     exists (new lifecycle); joins unfiltered
 *                               lists; unresolved in status lists
 *   deleted                     known absent; leaves every list
 *   renamed                     identity moves (context.old_name), fields kept
 *   started/restarted/resumed   status Running
 *   stopped/shutdown            status Stopped
 *   paused                      status Frozen
 *   updated, migrated           ordinary fields need validation
 * Sub-resources (snapshots, backups, files, logs...) do not change instances.
 */

const PREFIX = "instance\0";
const COLLECTION_PREFIX = "instances\0";
const STATUS = "status";
const ORDINARY = "ordinary";
/** Above this many single-instance fetches, one list request is cheaper. */
const MAX_INDIVIDUAL = 2;

const STATUS_FIELDS: readonly InstanceField[] = ["status", "statusCode"];
const IDENTITY_FIELDS: readonly InstanceField[] = ["name", "project"];

const STATUS_FROM_EVENT: Record<
	string,
	{ status: string; statusCode: number }
> = {
	started: { status: "Running", statusCode: 103 },
	restarted: { status: "Running", statusCode: 103 },
	resumed: { status: "Running", statusCode: 103 },
	stopped: { status: "Stopped", statusCode: 102 },
	shutdown: { status: "Stopped", statusCode: 102 },
	paused: { status: "Frozen", statusCode: 110 },
};

export const instanceKey = (id: InstanceIdentity) =>
	`${PREFIX}${id.project}\0${id.name}`;

function identityFromKey(key: string): InstanceIdentity {
	const [project = "", name = ""] = key.slice(PREFIX.length).split("\0");
	return { project, name };
}

function collectionKey(
	scope: ProjectScope,
	criteria: InstanceCriteria,
): string {
	return `${COLLECTION_PREFIX}${projectScopeKey(scope)}\0${criteria.status ?? ""}`;
}

function parseCollectionKey(
	key: string,
): { scope: ProjectScope; criteria: InstanceCriteria } | null {
	const [scopeKey = "", status = ""] = key
		.slice(COLLECTION_PREFIX.length)
		.split("\0");
	const scope = scopeFromKey(scopeKey);
	if (!scope) return null;
	return {
		scope,
		criteria: status ? { status: status as InstanceCriteria["status"] } : {},
	};
}

const inScope = (scope: ProjectScope, project: string) =>
	scope.kind === "all" || scope.name === project;

const groupOf = (field: InstanceField) =>
	IDENTITY_FIELDS.includes(field)
		? null
		: STATUS_FIELDS.includes(field)
			? STATUS
			: ORDINARY;

type Group = typeof STATUS | typeof ORDINARY;

const groupsFor = (fields: readonly InstanceField[]): Group[] =>
	[
		...new Set(fields.map(groupOf).filter((g): g is Group => g !== null)),
	].sort();

const order = (a: InstanceIdentity, b: InstanceIdentity) =>
	a.name.localeCompare(b.name) || a.project.localeCompare(b.project);

/* ------------------------------------------------------------------ needs */

export interface InstanceListNeed extends Need {
	kind: "list";
	scope: ProjectScope;
	criteria: InstanceCriteria;
	fields: readonly InstanceField[];
}

export interface InstanceNeed extends Need {
	kind: "one";
	id: InstanceIdentity;
	fields: readonly InstanceField[];
}

export type InstancesNeed = InstanceListNeed | InstanceNeed;

const normalize = (fields: readonly InstanceField[]) =>
	[...new Set<InstanceField>(["name", "project", ...fields])].sort();

export function instanceListNeed(
	fields: readonly InstanceField[],
	scope: ProjectScope,
	criteria: InstanceCriteria = {},
): InstanceListNeed {
	const normal = normalize(fields);
	return {
		key: `instances/list/${projectScopeKey(scope)}/${criteria.status ?? ""}/${normal.join(",")}`,
		kind: "list",
		scope,
		criteria: criteria.status ? { status: criteria.status } : {},
		fields: normal,
	};
}

export function instanceNeed(
	id: InstanceIdentity,
	fields: readonly InstanceField[],
): InstanceNeed {
	const normal = normalize(fields);
	return {
		key: `instances/one/${encodeURIComponent(id.project)}/${encodeURIComponent(id.name)}/${normal.join(",")}`,
		kind: "one",
		id,
		fields: normal,
	};
}

/* ---------------------------------------------------------------- reading */

interface Membership {
	/** Members known to match. */
	members: InstanceIdentity[];
	/** Possible members whose predicate fields are unknown. */
	undecided: InstanceIdentity[];
	/** Every member is known: complete membership and nothing undecided. */
	complete: boolean;
	fresh: boolean;
	stale: boolean;
}

/** Complete and not invalidated (it may still hold unresolved candidates). */
const usable = (c: CollectionRecord | undefined): c is CollectionRecord =>
	!!c && c.complete && !c.invalid;

/** Usable and with nothing unresolved: a settled answer. */
const settled = (c: CollectionRecord | undefined): c is CollectionRecord =>
	usable(c) && c.unresolved.size === 0;

/**
 * Membership for (scope, criteria), from the matching collection or derived
 * from a complete unfiltered collection of the same or a broader scope using
 * its members' known statuses. Members whose status is unknown are reported
 * as undecided rather than guessed; the planner resolves just those.
 */
function membership(
	scope: ProjectScope,
	criteria: InstanceCriteria,
	ctx: DataContext,
): Membership | null {
	const routes: Membership[] = [];
	const direct = ctx.store.collection(collectionKey(scope, criteria));
	if (usable(direct)) {
		routes.push({
			members: [...direct.members]
				.filter((key) => !direct.unresolved.has(key))
				.map(identityFromKey)
				.sort(order),
			undecided: [...direct.unresolved].map(identityFromKey),
			complete: direct.unresolved.size === 0,
			fresh: ctx.isFresh(direct.validation),
			stale: ctx.shouldValidate(direct.validation),
		});
	}
	const broader: ProjectScope[] =
		scope.kind === "all" ? [scope] : [scope, { kind: "all" }];
	for (const base of broader) {
		if (base === scope && !criteria.status) continue; // that is `direct`
		const collection = ctx.store.collection(collectionKey(base, {}));
		if (!settled(collection)) continue;
		let fresh = ctx.isFresh(collection.validation);
		let stale = ctx.shouldValidate(collection.validation);
		const members: InstanceIdentity[] = [];
		const undecided: InstanceIdentity[] = [];
		for (const key of collection.members) {
			const id = identityFromKey(key);
			if (!inScope(scope, id.project)) continue;
			if (!criteria.status) {
				members.push(id);
				continue;
			}
			const group = ctx.store.record(key)?.groups.get(STATUS);
			const match = matchesCriteria(
				group?.values.status as string | undefined,
				criteria,
			);
			if (match === undefined || !group) {
				undecided.push(id);
				continue;
			}
			if (!ctx.isFresh(group.validation)) fresh = false;
			if (ctx.shouldValidate(group.validation)) stale = true;
			if (match) members.push(id);
		}
		routes.push({
			members: members.sort(order),
			undecided,
			complete: undecided.length === 0,
			fresh,
			stale,
		});
	}
	const rank = (r: Membership) => (r.complete ? 0 : 2) + (r.fresh ? 0 : 1);
	return (
		routes.sort(
			(a, b) => rank(a) - rank(b) || a.undecided.length - b.undecided.length,
		)[0] ?? null
	);
}

interface ListState {
	rows: Partial<Instance>[] | undefined;
	missing: string[];
	complete: boolean;
	fresh: boolean;
	stale: boolean;
	/** Members whose selected fields must be fetched. */
	targets: InstanceIdentity[];
}

function pick(
	id: InstanceIdentity,
	values: Readonly<Record<string, unknown>>,
	fields: readonly InstanceField[],
): Partial<Instance> {
	const row: Record<string, unknown> = {};
	for (const field of fields) {
		row[field] =
			field === "name"
				? id.name
				: field === "project"
					? id.project
					: values[field];
	}
	return row as Partial<Instance>;
}

/** Selected fields of one instance, with their freshness. */
function readFields(
	id: InstanceIdentity,
	fields: readonly InstanceField[],
	ctx: DataContext,
) {
	const record = ctx.store.record(instanceKey(id));
	const values: Record<string, unknown> = {};
	let known = true;
	let fresh = true;
	let stale = false;
	for (const name of groupsFor(fields)) {
		const group = record?.groups.get(name);
		if (!group) {
			known = false;
			fresh = false;
			stale = true;
			continue;
		}
		Object.assign(values, group.values);
		if (group.invalid || !ctx.isFresh(group.validation)) fresh = false;
		if (group.invalid || ctx.shouldValidate(group.validation)) stale = true;
	}
	return { row: known ? pick(id, values, fields) : undefined, fresh, stale };
}

function readList(need: InstanceListNeed, ctx: DataContext): ListState {
	const found = membership(need.scope, need.criteria, ctx);
	if (!found) {
		return {
			rows: undefined,
			missing: [],
			complete: false,
			fresh: false,
			stale: true,
			targets: [],
		};
	}
	const rows: Partial<Instance>[] = [];
	const missing: string[] = [];
	const targets: InstanceIdentity[] = [];
	// Known members stay visible while undecided ones are resolved.
	let fresh = found.fresh && found.complete;
	let stale = found.stale;
	for (const id of found.members) {
		const fields = readFields(id, need.fields, ctx);
		if (!fields.fresh) fresh = false;
		if (fields.stale) {
			stale = true;
			targets.push(id);
		}
		if (fields.row) rows.push(fields.row);
		else missing.push(`${id.project}/${id.name}`);
	}
	return { rows, missing, complete: found.complete, fresh, stale, targets };
}

interface OneState {
	exists: boolean | undefined;
	row: Partial<Instance> | undefined;
	available: boolean;
	fresh: boolean;
	stale: boolean;
}

function readOne(need: InstanceNeed, ctx: DataContext): OneState {
	const record = ctx.store.record(instanceKey(need.id));
	let exists = record?.exists;
	let existence: Validation | undefined = record?.existence;
	if (exists === undefined) {
		// Derived fact: complete unfiltered membership covering its project.
		for (const scope of [
			{ kind: "project", name: need.id.project },
			{ kind: "all" },
		] as ProjectScope[]) {
			const collection = ctx.store.collection(collectionKey(scope, {}));
			if (settled(collection)) {
				exists = collection.members.has(instanceKey(need.id));
				existence = collection.validation;
				break;
			}
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
	if (!exists) {
		return {
			exists,
			row: undefined,
			available: true,
			fresh: existenceFresh,
			stale: existenceStale,
		};
	}
	const fields = readFields(need.id, need.fields, ctx);
	return {
		exists,
		row: fields.row,
		available: fields.row !== undefined,
		fresh: existenceFresh && fields.fresh,
		stale: existenceStale || fields.stale,
	};
}

/* ------------------------------------------------------------- reconciling */

/**
 * Re-evaluates every known collection for one instance after its existence
 * or status changed: it enters, leaves, or stays unresolved.
 */
function reconcileMembership(ctx: DataContext, id: InstanceIdentity): void {
	const key = instanceKey(id);
	const record = ctx.store.record(key);
	const status = record?.groups.get(STATUS)?.values.status as
		| string
		| undefined;
	for (const collection of ctx.store.collectionsWithPrefix(COLLECTION_PREFIX)) {
		const query = parseCollectionKey(collection.key);
		if (!query || !inScope(query.scope, id.project)) continue;
		if (record?.exists !== true) {
			ctx.store.removeMember(collection.key, key);
			continue;
		}
		const match = matchesCriteria(status, query.criteria);
		if (match === true) ctx.store.addMember(collection.key, key);
		else if (match === false) ctx.store.removeMember(collection.key, key);
		else ctx.store.addUnresolved(collection.key, key);
	}
}

function applyStatus(
	ctx: DataContext,
	instance: Instance,
	v: Validation,
): void {
	const key = instanceKey(instance);
	const existing = ctx.store.record(key)?.groups.get(STATUS);
	// No server revision: of two overlapping reads keep the later-sent one.
	if (existing && !existing.invalid && existing.validation.at > v.at) return;
	ctx.store.setGroup(
		key,
		STATUS,
		{ status: instance.status, statusCode: instance.statusCode },
		v,
	);
}

function applyObject(
	ctx: DataContext,
	instance: Instance,
	v: Validation,
): void {
	const key = instanceKey(instance);
	ctx.store.markExists(key, v);
	applyStatus(ctx, instance, v);
	const existing = ctx.store.record(key)?.groups.get(ORDINARY);
	if (!existing || existing.invalid || existing.validation.at <= v.at) {
		ctx.store.setGroup(
			key,
			ORDINARY,
			{
				type: instance.type,
				location: instance.location,
				architecture: instance.architecture,
				description: instance.description,
				createdAt: instance.createdAt,
				lastUsedAt: instance.lastUsedAt,
				profiles: instance.profiles,
			},
			v,
		);
	}
}

/**
 * Applies a collection response. A complete unfiltered list also establishes
 * that instances in its scope that it does not contain no longer exist; a
 * filtered list only establishes its own membership.
 */
function applyCollection(
	ctx: DataContext,
	scope: ProjectScope,
	criteria: InstanceCriteria,
	ids: readonly InstanceIdentity[],
	v: Validation,
	objects?: readonly Instance[],
): void {
	for (const id of ids) ctx.store.markExists(instanceKey(id), v);
	for (const object of objects ?? []) applyObject(ctx, object, v);
	ctx.store.setCollection(
		collectionKey(scope, criteria),
		ids.map(instanceKey),
		true,
		v,
	);
	const present = new Set(ids.map(instanceKey));
	if (!criteria.status) {
		for (const record of ctx.store.recordsWithPrefix(PREFIX)) {
			const id = identityFromKey(record.key);
			if (
				record.exists === true &&
				inScope(scope, id.project) &&
				!present.has(record.key)
			) {
				ctx.store.markAbsent(record.key, v);
				reconcileMembership(ctx, id);
			}
		}
	}
	if (objects) {
		// Known statuses update every other status query too.
		for (const object of objects) reconcileMembership(ctx, object);
	}
}

const wantsFields = (need: InstancesNeed) => groupsFor(need.fields).length > 0;

function listRequest(
	scope: ProjectScope,
	criteria: InstanceCriteria,
	objects: boolean,
): PlannedRequest<InstancesNeed> {
	const filtered = !!criteria.status;
	return {
		key: `GET /1.0/instances?${objects ? "recursion=1&" : ""}scope=${projectScopeKey(scope)}&status=${criteria.status ?? ""}`,
		covers: (need) => {
			if (need.kind === "one") {
				return (
					!filtered &&
					inScope(scope, need.id.project) &&
					(objects || !wantsFields(need))
				);
			}
			if (!objects && wantsFields(need)) return false;
			if (!filtered) {
				return (
					(scope.kind === "all" ||
						projectScopeKey(scope) === projectScopeKey(need.scope)) &&
					(objects || !need.criteria.status)
				);
			}
			return (
				projectScopeKey(scope) === projectScopeKey(need.scope) &&
				need.criteria.status === criteria.status
			);
		},
		async run(signal) {
			if (objects) {
				const list = await fetchInstanceObjects(scope, criteria, { signal });
				return (ctx, v) => applyCollection(ctx, scope, criteria, list, v, list);
			}
			const ids = await fetchInstanceIdentities(scope, criteria, { signal });
			return (ctx, v) => applyCollection(ctx, scope, criteria, ids, v);
		},
	};
}

function oneRequest(
	id: InstanceIdentity,
	ctx: DataContext,
): PlannedRequest<InstancesNeed> {
	return {
		key: `GET /1.0/instances/${id.name}?project=${id.project}`,
		covers: (need) =>
			need.kind === "one"
				? instanceKey(need.id) === instanceKey(id)
				: readList(need, ctx).targets.some(
						(t) => instanceKey(t) === instanceKey(id),
					),
		async run(signal) {
			const instance = await fetchInstance(id, { signal });
			return (c, v) => {
				if (instance === null) c.store.markAbsent(instanceKey(id), v);
				else applyObject(c, instance, v);
				reconcileMembership(c, id);
			};
		},
	};
}

function eventTarget(event: IncusEvent) {
	const change = parseResourceChange(event);
	if (!change || change.collection !== "instances" || !change.name) return null;
	// /1.0/instances/{name}/... are sub-resources (snapshots, files, logs...).
	if (change.path.split("/").filter(Boolean).length !== 3) return null;
	const meta = event.metadata as {
		source?: unknown;
		context?: { old_name?: unknown };
	};
	const source = typeof meta.source === "string" ? meta.source : "";
	const fromSource = new URLSearchParams(source.split("?")[1] ?? "").get(
		"project",
	);
	const project = change.project ?? fromSource ?? "default";
	const oldName =
		typeof meta.context?.old_name === "string" ? meta.context.old_name : null;
	return { id: { project, name: change.name }, verb: change.verb, oldName };
}

export const instancesDefinition: ResourceDefinition<InstancesNeed> = {
	name: "instances",

	applyEvent(event, ctx) {
		const target = eventTarget(event);
		if (!target) return;
		const { id, verb, oldName } = target;
		const key = instanceKey(id);
		const v = ctx.eventValidation();
		const status = STATUS_FROM_EVENT[verb];
		if (status) {
			ctx.store.markExists(key, v);
			ctx.store.setGroup(key, STATUS, status, v);
			reconcileMembership(ctx, id);
			return;
		}
		switch (verb) {
			case "created":
				ctx.store.restart(key, v);
				reconcileMembership(ctx, id);
				return;
			case "deleted":
				ctx.store.markAbsent(key, v);
				reconcileMembership(ctx, id);
				return;
			case "renamed": {
				if (!oldName) return;
				const old = { project: id.project, name: oldName };
				const oldKey = instanceKey(old);
				const applied =
					ctx.store.record(key)?.exists === true &&
					ctx.store.record(oldKey)?.exists === false;
				if (!applied) {
					ctx.store.restart(key, v);
					ctx.store.copyGroups(oldKey, key);
					ctx.store.markAbsent(oldKey, v);
				}
				reconcileMembership(ctx, old);
				reconcileMembership(ctx, id);
				return;
			}
			case "updated":
			case "migrated":
				ctx.store.invalidateGroup(key, ORDINARY);
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
		const requests = new Map<string, PlannedRequest<InstancesNeed>>();
		/** Single-instance fetches, with the needs that asked for them. */
		const individual = new Map<
			string,
			{ id: InstanceIdentity; for: InstancesNeed[] }
		>();
		const fetchOne = (id: InstanceIdentity, need: InstancesNeed) => {
			const key = instanceKey(id);
			const entry = individual.get(key) ?? { id, for: [] };
			entry.for.push(need);
			individual.set(key, entry);
		};
		const add = (request: PlannedRequest<InstancesNeed>) =>
			requests.set(request.key, request);

		for (const need of needs) {
			if (need.kind === "one") {
				fetchOne(need.id, need);
				continue;
			}
			const found = membership(need.scope, need.criteria, ctx);
			if (!found || found.stale || found.undecided.length > MAX_INDIVIDUAL) {
				// Membership is unknown, needs validation, or too much is undecided.
				add(listRequest(need.scope, need.criteria, wantsFields(need)));
				continue;
			}
			// Resolve only the few members whose predicate fields are unknown.
			for (const id of found.undecided) fetchOne(id, need);
			const { targets } = readList(need, ctx);
			if (targets.length > MAX_INDIVIDUAL) {
				add(listRequest(need.scope, need.criteria, true));
			} else {
				for (const id of targets) fetchOne(id, need);
			}
		}

		const planned = [...requests.values()];
		// Drop requests made redundant by a broader one in the same pass.
		const broad = planned.filter(
			(r) => r.key.includes("recursion=1") && r.key.endsWith("&status="),
		);
		const kept = planned.filter(
			(r) =>
				broad.includes(r) ||
				!broad.some((b) =>
					needs.filter((n) => r.covers(n)).every((n) => b.covers(n)),
				),
		);
		for (const entry of individual.values()) {
			const covered = entry.for.every((n) => kept.some((r) => r.covers(n)));
			if (!covered) kept.push(oneRequest(entry.id, ctx));
		}
		return kept;
	},
};

/* ------------------------------------------------------------- consumers */

type Selected<F extends readonly InstanceField[]> = Pick<
	Instance,
	F[number] | "name" | "project"
>;

/** The instances surface: the same machinery for hooks and imperative code. */
export function createInstancesApi(core: DataCore) {
	core.register(instancesDefinition);

	const listResult = <F extends readonly InstanceField[]>(
		need: InstanceListNeed,
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

	const oneResult = <F extends readonly InstanceField[]>(
		need: InstanceNeed,
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

	const watchList = <F extends readonly InstanceField[]>(
		fields: F,
		scope: ProjectScope,
		criteria: InstanceCriteria = {},
	): Watch<CollectionResult<Selected<F>>> => {
		const need = instanceListNeed(fields, scope, criteria);
		return watch(core, instancesDefinition, need, () => listResult<F>(need));
	};

	const watchOne = <F extends readonly InstanceField[]>(
		id: InstanceIdentity,
		fields: F,
	): Watch<ResourceResult<Selected<F>>> => {
		const need = instanceNeed(id, fields);
		return watch(core, instancesDefinition, need, () => oneResult<F>(need));
	};

	return {
		watchList,
		watch: watchOne,
		list: <F extends readonly InstanceField[]>(
			fields: F,
			scope: ProjectScope,
			criteria: InstanceCriteria = {},
		) => settle(watchList(fields, scope, criteria)),
		get: <F extends readonly InstanceField[]>(
			id: InstanceIdentity,
			fields: F,
		) => settle(watchOne(id, fields)),
		refreshList: (
			fields: readonly InstanceField[],
			scope: ProjectScope,
			criteria: InstanceCriteria = {},
		) => core.refresh(instanceListNeed(fields, scope, criteria).key),
		refresh: (id: InstanceIdentity, fields: readonly InstanceField[]) =>
			core.refresh(instanceNeed(id, fields).key),
	};
}

export type InstancesApi = ReturnType<typeof createInstancesApi>;
