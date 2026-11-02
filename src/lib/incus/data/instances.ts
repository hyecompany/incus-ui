// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { supports, unsupported } from "../capabilities.ts";
import { IncusApiError, type IncusOperationRef } from "../client.ts";
import type { IncusEvent } from "../events/types.ts";
import {
	changeInstanceState,
	deleteInstance,
	fetchInstanceIdentities,
	fetchInstanceObjects,
	fetchInstanceState,
	fetchInstancesFull,
	fetchInstanceWithEtag,
	type Instance,
	type InstanceAction,
	type InstanceCriteria,
	type InstanceField,
	type InstanceIdentity,
	type InstanceObject,
	type InstancePut,
	type InstanceRuntime,
	matchesCriteria,
	putInstance,
	writableInstance,
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
import type { OperationHandle } from "./operations.ts";
import type { CollectionRecord, FieldGroup, Validation } from "./store.ts";

const PREFIX = "instance\0";
const COLLECTION_PREFIX = "instances\0";
const PROFILE_PREFIX = "profile\0";
const PROJECT_PREFIX = "project\0";

/* Field groups: fields one representation returns and invalidates together. */
const STATUS = "status";
const ORDINARY = "ordinary";
/** Local config and devices: replaced whole by every object representation. */
const CONFIG = "config";
/** Profile-expanded config and devices: also depends on every profile used. */
const EXPANDED = "expanded";
/** Runtime state: sampled, no event describes its changes. */
const RUNTIME = "runtime";

/** Relationship kind: instance -> the profiles it applies. */
export const USES_PROFILE = "uses-profile";

/** Above this many single-instance fetches, one list request is cheaper. */
const MAX_INDIVIDUAL = 2;
/** Default sampling interval for runtime state while someone watches it. */
const DEFAULT_SAMPLE_MS = 5_000;

const GROUP_OF: Record<InstanceField, string | null> = {
	name: null,
	project: null,
	status: STATUS,
	statusCode: STATUS,
	type: ORDINARY,
	location: ORDINARY,
	architecture: ORDINARY,
	description: ORDINARY,
	createdAt: ORDINARY,
	lastUsedAt: ORDINARY,
	profiles: ORDINARY,
	ephemeral: CONFIG,
	stateful: CONFIG,
	config: CONFIG,
	devices: CONFIG,
	expandedConfig: EXPANDED,
	expandedDevices: EXPANDED,
	pid: RUNTIME,
	processes: RUNTIME,
	cpuUsage: RUNTIME,
	memory: RUNTIME,
	disk: RUNTIME,
	network: RUNTIME,
};

/** Groups the object representation (recursion=1, individual GET) supplies. */
const OBJECT_GROUPS = new Set([STATUS, ORDINARY, CONFIG, EXPANDED]);

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

const profileKey = (project: string, name: string) =>
	`${PROFILE_PREFIX}${project}\0${name}`;

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

const groupsFor = (fields: readonly InstanceField[]): string[] =>
	[
		...new Set(
			fields.map((f) => GROUP_OF[f]).filter((g): g is string => g !== null),
		),
	].sort();

const order = (a: InstanceIdentity, b: InstanceIdentity) =>
	a.name.localeCompare(b.name) || a.project.localeCompare(b.project);

/* ------------------------------------------------------------ persistence */

/** Config keys known to carry no secrets. Anything else keeps a group in memory only. */
const SAFE_CONFIG_PREFIXES = [
	"boot.",
	"cluster.",
	"image.",
	"limits.",
	"linux.",
	"migration.",
	"security.",
	"snapshots.",
	"volatile.",
];

/** Device keys known to carry no secrets. */
const SAFE_DEVICE_KEYS = new Set([
	"type",
	"name",
	"path",
	"source",
	"pool",
	"network",
	"nictype",
	"parent",
	"hwaddr",
	"mtu",
	"vlan",
	"size",
	"readonly",
	"required",
	"recursive",
	"shift",
	"propagation",
	"boot.priority",
	"ipv4.address",
	"ipv6.address",
	"listen",
	"connect",
	"bind",
	"gputype",
	"id",
	"pci",
	"productid",
	"vendorid",
	"uid",
	"gid",
	"mode",
	"major",
	"minor",
]);

const safeConfig = (config: unknown) =>
	typeof config === "object" &&
	config !== null &&
	Object.keys(config).every((key) =>
		SAFE_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix)),
	);

const safeDevices = (devices: unknown) =>
	typeof devices === "object" &&
	devices !== null &&
	Object.values(devices).every(
		(device) =>
			typeof device === "object" &&
			device !== null &&
			Object.keys(device).every(
				(key) => SAFE_DEVICE_KEYS.has(key) || key.startsWith("limits."),
			),
	);

/** Allowlisted per group. Runtime state is sampled and never persisted. */
function persistGroup(
	group: string,
	values: Readonly<Record<string, unknown>>,
): boolean {
	switch (group) {
		case STATUS:
		case ORDINARY:
			return true;
		case CONFIG:
			return safeConfig(values.config) && safeDevices(values.devices);
		case EXPANDED:
			return (
				safeConfig(values.expandedConfig) && safeDevices(values.expandedDevices)
			);
		default:
			return false;
	}
}

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

/** Sampling policy for runtime state (set per data layer). */
const sampling = new WeakMap<DataContext, number>();
const sampleMs = (ctx: DataContext) => sampling.get(ctx) ?? DEFAULT_SAMPLE_MS;

/** Freshness of one group under its own rules. */
function groupFresh(name: string, group: FieldGroup, ctx: DataContext) {
	if (group.invalid) return { fresh: false, stale: true };
	if (name === RUNTIME) {
		// Sampled: an open event connection does not keep it fresh.
		const fresh =
			group.validation.source !== "restored" &&
			ctx.now() - group.validation.at < sampleMs(ctx);
		return { fresh, stale: !fresh };
	}
	return {
		fresh: ctx.isFresh(group.validation),
		stale: ctx.shouldValidate(group.validation),
	};
}

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

/** Membership for (scope, criteria), direct or derived from a broader complete list. */
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
	/** Members whose object-representation fields must be fetched. */
	targets: InstanceIdentity[];
	/** Members whose runtime state must be sampled. */
	runtimeTargets: InstanceIdentity[];
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
	let objectStale = false;
	let runtimeStale = false;
	for (const name of groupsFor(fields)) {
		const group = record?.groups.get(name);
		const state = group
			? groupFresh(name, group, ctx)
			: { fresh: false, stale: true };
		if (!group) known = false;
		else Object.assign(values, group.values);
		if (!state.fresh) fresh = false;
		if (state.stale) {
			if (name === RUNTIME) runtimeStale = true;
			else objectStale = true;
		}
	}
	return {
		row: known ? pick(id, values, fields) : undefined,
		fresh,
		objectStale,
		runtimeStale,
	};
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
			runtimeTargets: [],
		};
	}
	const rows: Partial<Instance>[] = [];
	const missing: string[] = [];
	const targets: InstanceIdentity[] = [];
	const runtimeTargets: InstanceIdentity[] = [];
	// Known members stay visible while undecided ones are resolved.
	let fresh = found.fresh && found.complete;
	let stale = found.stale;
	for (const id of found.members) {
		const fields = readFields(id, need.fields, ctx);
		if (!fields.fresh) fresh = false;
		if (fields.objectStale) {
			stale = true;
			targets.push(id);
		}
		if (fields.runtimeStale) {
			stale = true;
			runtimeTargets.push(id);
		}
		if (fields.row) rows.push(fields.row);
		else missing.push(`${id.project}/${id.name}`);
	}
	return {
		rows,
		missing,
		complete: found.complete,
		fresh,
		stale,
		targets,
		runtimeTargets,
	};
}

interface OneState {
	exists: boolean | undefined;
	row: Partial<Instance> | undefined;
	available: boolean;
	fresh: boolean;
	stale: boolean;
	objectStale: boolean;
	runtimeStale: boolean;
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
	const unknown = {
		exists,
		row: undefined,
		available: false,
		fresh: false,
		stale: true,
		objectStale: true,
		runtimeStale: false,
	};
	if (exists === undefined) return unknown;
	const existenceFresh = ctx.isFresh(existence);
	const existenceStale = ctx.shouldValidate(existence);
	if (!exists) {
		return {
			exists,
			row: undefined,
			available: true,
			fresh: existenceFresh,
			stale: existenceStale,
			objectStale: existenceStale,
			runtimeStale: false,
		};
	}
	const fields = readFields(need.id, need.fields, ctx);
	return {
		exists,
		row: fields.row,
		available: fields.row !== undefined,
		fresh: existenceFresh && fields.fresh,
		stale: existenceStale || fields.objectStale || fields.runtimeStale,
		objectStale: existenceStale || fields.objectStale,
		runtimeStale: fields.runtimeStale,
	};
}

/* ------------------------------------------------------------- reconciling */

/** Re-evaluates collection membership for one instance. */
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

/** Sets a group unless a later-sent read already supplied it. */
function setLatest(
	ctx: DataContext,
	key: string,
	group: string,
	values: Record<string, unknown>,
	v: Validation,
): void {
	const existing = ctx.store.record(key)?.groups.get(group);
	// No server revision: of two overlapping reads keep the later-sent one.
	if (existing && !existing.invalid && existing.validation.at > v.at) return;
	ctx.store.setGroup(key, group, values, v);
}

function applyStatus(
	ctx: DataContext,
	id: InstanceIdentity,
	status: { status: string; statusCode: number },
	v: Validation,
): void {
	setLatest(
		ctx,
		instanceKey(id),
		STATUS,
		{ status: status.status, statusCode: status.statusCode },
		v,
	);
}

function applyObject(
	ctx: DataContext,
	instance: InstanceObject,
	v: Validation,
): void {
	const key = instanceKey(instance);
	ctx.store.markExists(key, v);
	applyStatus(ctx, instance, instance, v);
	setLatest(
		ctx,
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
	// Authoritative replacement: keys missing from the response are gone.
	setLatest(
		ctx,
		key,
		CONFIG,
		{
			config: instance.config,
			devices: instance.devices,
			ephemeral: instance.ephemeral,
			stateful: instance.stateful,
		},
		v,
	);
	setLatest(
		ctx,
		key,
		EXPANDED,
		{
			expandedConfig: instance.expandedConfig,
			expandedDevices: instance.expandedDevices,
		},
		v,
	);
	// The response establishes which profiles the instance applies.
	ctx.store.setRelation(
		key,
		USES_PROFILE,
		instance.profiles.map((name) => profileKey(instance.project, name)),
		v,
	);
}

function applyRuntime(
	ctx: DataContext,
	id: InstanceIdentity,
	state: InstanceRuntime,
	v: Validation,
): void {
	const key = instanceKey(id);
	ctx.store.markExists(key, v);
	applyStatus(ctx, id, state, v);
	setLatest(
		ctx,
		key,
		RUNTIME,
		{
			pid: state.pid,
			processes: state.processes,
			cpuUsage: state.cpuUsage,
			memory: state.memory,
			disk: state.disk,
			network: state.network,
		},
		v,
	);
	reconcileMembership(ctx, id);
}

/** Applies a collection response. */
function applyCollection(
	ctx: DataContext,
	scope: ProjectScope,
	criteria: InstanceCriteria,
	ids: readonly InstanceIdentity[],
	v: Validation,
	objects?: readonly InstanceObject[],
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

/**
 * Instances whose expanded config depends on profile (project, name). With
 * `features.profiles=false` a project uses the default project's profiles, so a
 * default-project profile may affect any project whose setting is not known.
 */
function dependentsOfProfile(
	ctx: DataContext,
	project: string,
	name: string,
): string[] {
	const keys = new Set<string>();
	for (const relation of ctx.store.relationsTo(
		profileKey(project, name),
		USES_PROFILE,
	)) {
		keys.add(relation.from);
	}
	// Restored or remote records carry no relationship entries: use their fields.
	for (const record of ctx.store.recordsWithPrefix(PREFIX)) {
		if (
			!record.groups.has(EXPANDED) ||
			ctx.store.relation(record.key, USES_PROFILE)
		)
			continue;
		const profiles = record.groups.get(ORDINARY)?.values.profiles as
			| readonly string[]
			| undefined;
		if (!profiles || profiles.includes(name)) keys.add(record.key);
	}
	if (project === "default") {
		for (const record of ctx.store.recordsWithPrefix(PREFIX)) {
			const id = identityFromKey(record.key);
			if (id.project === "default") continue;
			const projectConfig = ctx.store
				.record(`${PROJECT_PREFIX}${id.project}`)
				?.groups.get("details")?.values.config as
				| Record<string, string>
				| undefined;
			if (projectConfig?.["features.profiles"] === "true") continue;
			const relation = ctx.store.relation(record.key, USES_PROFILE);
			if (relation?.targets.has(profileKey(id.project, name)))
				keys.add(record.key);
		}
	}
	return [...keys];
}

const wantsObjects = (need: InstancesNeed) =>
	groupsFor(need.fields).some((g) => OBJECT_GROUPS.has(g));
const wantsRuntime = (need: InstancesNeed) =>
	groupsFor(need.fields).includes(RUNTIME);

/** The collection request, adapted to what the deployment supports (#7). */
function listRequest(
	scope: ProjectScope,
	criteria: InstanceCriteria,
	representation: "urls" | "objects" | "full",
	ctx: DataContext,
): PlannedRequest<InstancesNeed> {
	const filtered = !!criteria.status;
	const objects = representation !== "urls";
	const recursion =
		representation === "full" ? 2 : representation === "objects" ? 1 : 0;
	return {
		key: `GET /1.0/instances?recursion=${recursion}&scope=${projectScopeKey(scope)}&status=${criteria.status ?? ""}`,
		covers: (need) => {
			if (wantsRuntime(need) && representation !== "full") return false;
			if (need.kind === "one") {
				return (
					!filtered &&
					inScope(scope, need.id.project) &&
					(objects || !wantsObjects(need))
				);
			}
			if (!objects && wantsObjects(need)) return false;
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
			if (scope.kind === "all" && !supports(ctx.capabilities, "allProjects")) {
				throw unsupported("allProjects", "Listing instances across projects");
			}
			if (representation === "full") {
				const list = await fetchInstancesFull(scope, criteria, { signal });
				return (c, v) => {
					const instances = list.map((entry) => entry.instance);
					applyCollection(c, scope, criteria, instances, v, instances);
					for (const entry of list)
						if (entry.state) applyRuntime(c, entry.instance, entry.state, v);
				};
			}
			if (objects) {
				const list = await fetchInstanceObjects(scope, criteria, { signal });
				return (c, v) => applyCollection(c, scope, criteria, list, v, list);
			}
			const ids = await fetchInstanceIdentities(scope, criteria, { signal });
			return (c, v) => applyCollection(c, scope, criteria, ids, v);
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
				? instanceKey(need.id) === instanceKey(id) &&
					(!wantsRuntime(need) || !readOne(need, ctx).runtimeStale)
				: readList(need, ctx).targets.some(
						(t) => instanceKey(t) === instanceKey(id),
					),
		async run(signal) {
			const found = await fetchInstanceWithEtag(id, { signal });
			return (c, v) => {
				if (found === null) c.store.markAbsent(instanceKey(id), v);
				else applyObject(c, found.instance, v);
				reconcileMembership(c, id);
			};
		},
	};
}

function stateRequest(
	id: InstanceIdentity,
	ctx: DataContext,
): PlannedRequest<InstancesNeed> {
	return {
		key: `GET /1.0/instances/${id.name}/state?project=${id.project}`,
		covers: (need) =>
			need.kind === "one"
				? instanceKey(need.id) === instanceKey(id) &&
					(!wantsObjects(need) || !readOne(need, ctx).objectStale)
				: readList(need, ctx).runtimeTargets.some(
						(t) => instanceKey(t) === instanceKey(id),
					),
		async run(signal) {
			const state = await fetchInstanceState(id, { signal });
			return (c, v) => {
				if (state === null) {
					c.store.markAbsent(instanceKey(id), v);
					reconcileMembership(c, id);
				} else applyRuntime(c, id, state, v);
			};
		},
	};
}

function eventTarget(event: IncusEvent) {
	const change = parseResourceChange(event);
	if (!change || !change.name) return null;
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
	return {
		collection: change.collection,
		depth: change.path.split("/").filter(Boolean).length,
		id: { project, name: change.name },
		verb: change.verb,
		oldName,
	};
}

function applyProfileEvent(
	ctx: DataContext,
	target: NonNullable<ReturnType<typeof eventTarget>>,
): void {
	if (target.depth !== 3) return;
	const { project, name } = target.id;
	switch (target.verb) {
		case "updated":
		case "deleted":
		case "renamed":
			// The derived value depends on the profile: recompute it.
			for (const key of dependentsOfProfile(ctx, project, name)) {
				ctx.store.invalidateGroup(key, EXPANDED);
			}
			if (target.verb === "renamed") {
				// Incus updates the instances' profile lists along with the rename.
				for (const key of dependentsOfProfile(ctx, project, name)) {
					ctx.store.invalidateGroup(key, ORDINARY);
				}
			}
	}
}

export const instancesDefinition: ResourceDefinition<InstancesNeed> = {
	name: "instances",

	applyEvent(event, ctx) {
		const target = eventTarget(event);
		if (!target) return;
		if (target.collection === "profiles") {
			applyProfileEvent(ctx, target);
			return;
		}
		// /1.0/instances/{name}/... are sub-resources (snapshots, files, logs...).
		if (target.collection !== "instances" || target.depth !== 3) return;
		const { id, verb, oldName } = target;
		const key = instanceKey(id);
		const v = ctx.eventValidation();
		const status = STATUS_FROM_EVENT[verb];
		if (status) {
			ctx.store.markExists(key, v);
			ctx.store.setGroup(key, STATUS, status, v);
			ctx.store.invalidateGroup(key, RUNTIME);
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
					const relation = ctx.store.relation(oldKey, USES_PROFILE);
					ctx.store.restart(key, v);
					ctx.store.copyGroups(oldKey, key);
					if (relation)
						ctx.store.setRelation(
							key,
							USES_PROFILE,
							relation.targets,
							relation.validation,
						);
					ctx.store.markAbsent(oldKey, v);
				}
				reconcileMembership(ctx, old);
				reconcileMembership(ctx, id);
				return;
			}
			case "updated":
			case "migrated":
				ctx.store.invalidateGroup(key, ORDINARY);
				ctx.store.invalidateGroup(key, CONFIG);
				ctx.store.invalidateGroup(key, EXPANDED);
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

	revalidateAt(need, ctx) {
		if (!wantsRuntime(need)) return null;
		const ids =
			need.kind === "one"
				? [need.id]
				: (membership(need.scope, need.criteria, ctx)?.members ?? []);
		let due: number | null = null;
		for (const id of ids) {
			const group = ctx.store.record(instanceKey(id))?.groups.get(RUNTIME);
			if (!group) continue;
			const at = group.validation.at + sampleMs(ctx);
			if (due === null || at < due) due = at;
		}
		return due;
	},

	plan(needs, ctx) {
		const requests = new Map<string, PlannedRequest<InstancesNeed>>();
		/** Single-instance fetches, with the needs that asked for them. */
		const individual = new Map<
			string,
			{ id: InstanceIdentity; for: InstancesNeed[] }
		>();
		const runtime = new Map<
			string,
			{ id: InstanceIdentity; for: InstancesNeed[] }
		>();
		const addTo = (
			map: typeof individual,
			id: InstanceIdentity,
			need: InstancesNeed,
		) => {
			const key = instanceKey(id);
			const entry = map.get(key) ?? { id, for: [] };
			entry.for.push(need);
			map.set(key, entry);
		};
		const add = (request: PlannedRequest<InstancesNeed>) =>
			requests.set(request.key, request);
		const filtering = supports(ctx.capabilities, "filtering");
		const full = supports(ctx.capabilities, "instanceFull");
		/** Without server filtering, fetch the broader list and evaluate locally. */
		const list = (
			need: InstanceListNeed,
			representation: "urls" | "objects" | "full",
		) => {
			const criteria = filtering ? need.criteria : {};
			const rep =
				!filtering && need.criteria.status && representation === "urls"
					? "objects"
					: representation;
			add(listRequest(need.scope, criteria, rep, ctx));
		};

		for (const need of needs) {
			if (need.kind === "one") {
				const state = readOne(need, ctx);
				const object = wantsObjects(need)
					? state.objectStale || !state.available
					: !wantsRuntime(need) && state.stale;
				if (object) addTo(individual, need.id, need);
				if (wantsRuntime(need) && state.exists !== false)
					addTo(runtime, need.id, need);
				continue;
			}
			const found = membership(need.scope, need.criteria, ctx);
			const initial =
				wantsRuntime(need) && full
					? "full"
					: wantsObjects(need)
						? "objects"
						: "urls";
			if (!found || found.stale || found.undecided.length > MAX_INDIVIDUAL) {
				// Membership is unknown, needs validation, or too much is undecided.
				list(need, initial);
				continue;
			}
			// Resolve only the few members whose predicate fields are unknown.
			for (const id of found.undecided) addTo(individual, id, need);
			const { targets, runtimeTargets } = readList(need, ctx);
			if (targets.length > MAX_INDIVIDUAL) {
				list(need, wantsRuntime(need) && full ? "full" : "objects");
			} else {
				for (const id of targets) addTo(individual, id, need);
			}
			if (runtimeTargets.length > MAX_INDIVIDUAL && full) {
				list(need, "full");
			} else {
				for (const id of runtimeTargets) addTo(runtime, id, need);
			}
		}

		const planned = [...requests.values()];
		// Drop requests made redundant by a broader one in the same pass.
		const broad = planned.filter(
			(r) => !r.key.includes("recursion=0") && r.key.endsWith("&status="),
		);
		const kept = planned.filter(
			(r) =>
				broad.includes(r) ||
				!broad.some((b) =>
					needs.filter((n) => r.covers(n)).every((n) => b.covers(n)),
				),
		);
		const coveredByList = (need: InstancesNeed) =>
			kept.some((r) => r.covers(need));
		for (const entry of individual.values()) {
			if (!entry.for.every(coveredByList)) kept.push(oneRequest(entry.id, ctx));
		}
		for (const entry of runtime.values()) {
			if (!entry.for.every(coveredByList))
				kept.push(stateRequest(entry.id, ctx));
		}
		return kept;
	},

	persistence: {
		recordPrefix: PREFIX,
		collectionPrefix: COLLECTION_PREFIX,
		group: persistGroup,
		collection: () => true,
	},
};

/**
 * Existence learned from another resource's response (e.g. a project's
 * `used_by`). Establishes existence only: no status or other fields.
 */
export function observeInstanceExists(
	ctx: DataContext,
	id: InstanceIdentity,
	v: Validation,
): string {
	const key = instanceKey(id);
	const record = ctx.store.record(key);
	// A newer observation of absence wins over this one.
	if (record?.exists === false && (record.existence?.at ?? 0) > v.at)
		return key;
	ctx.store.markExists(key, v);
	reconcileMembership(ctx, id);
	return key;
}

/* --------------------------------------------------------------- commands */

/** An edit in progress: the writable baseline and the ETag that validates it. */
export interface InstanceDraft {
	readonly id: InstanceIdentity;
	readonly baseline: Readonly<InstancePut>;
	/** Precondition for the PUT. Later reads never replace it. */
	readonly etag: string | null;
}

export interface CommandResult {
	/** Set when Incus accepted the command as a background operation. */
	operation: OperationHandle | null;
}

/** A command whose request may have reached the server: never replayed. */
function commandError(cause: unknown): IncusApiError {
	if (!(cause instanceof IncusApiError)) {
		return new IncusApiError(
			"network",
			"The request may or may not have been applied",
			{ cause },
		);
	}
	if (cause.kind === "network") {
		return new IncusApiError(
			"network",
			"The connection failed after sending; the command's outcome is unknown",
			{ cause },
		);
	}
	return cause;
}

/* ------------------------------------------------------------- consumers */

type Selected<F extends readonly InstanceField[]> = Pick<
	Instance,
	F[number] | "name" | "project"
>;

export interface InstancesApiOptions {
	/** Sampling interval for runtime state while it is watched (ms). */
	runtimeSampleMs?: number;
}

/** The instances surface: the same machinery for hooks and imperative code. */
export function createInstancesApi(
	core: DataCore,
	options: InstancesApiOptions = {},
) {
	core.register(instancesDefinition);
	if (options.runtimeSampleMs !== undefined)
		sampling.set(core.context, options.runtimeSampleMs);

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
			fetching: core.isFetching(instancesDefinition, need),
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
			fetching: core.isFetching(instancesDefinition, need),
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

	/**
	 * Central invalidation, plus a revalidating read if the data is cached.
	 * With `since`, groups already re-observed (fresh) after that time are kept:
	 * covered events reported the change, so no refetch is needed.
	 */
	const affected = (
		id: InstanceIdentity,
		groups: readonly string[],
		since?: number,
	) => {
		const key = instanceKey(id);
		const generation = core.currentGeneration;
		const stale: string[] = [];
		core.mutate((ctx) => {
			const record = ctx.store.record(key);
			for (const group of groups) {
				const current = record?.groups.get(group);
				const observed =
					since !== undefined &&
					current &&
					!current.invalid &&
					current.validation.at >= since &&
					groupFresh(group, current, ctx).fresh;
				if (observed) continue;
				stale.push(group);
				ctx.store.invalidateGroup(key, group);
			}
		});
		groups = stale;
		const cached = core.store.record(key);
		if (!cached || !core.isCurrent(generation)) return Promise.resolve();
		const wantsObject = groups.some(
			(g) => OBJECT_GROUPS.has(g) && cached.groups.has(g),
		);
		const wantsState = groups.includes(RUNTIME) && cached.groups.has(RUNTIME);
		return Promise.all([
			wantsObject
				? core.read(instancesDefinition, oneRequest(id, core.context))
				: undefined,
			wantsState
				? core.read(instancesDefinition, stateRequest(id, core.context))
				: undefined,
		]).then(() => undefined);
	};

	const track = (
		ref: IncusOperationRef | null,
		id: InstanceIdentity,
		groups: readonly string[],
		onSuccess?: () => void,
	): CommandResult => {
		if (!ref) return { operation: null };
		const since = core.context.now();
		const operation = core.operations.register(ref, {
			project: id.project,
			onDone: (record) => {
				if (record.status === "Success") onSuccess?.();
				return affected(id, groups, since);
			},
		});
		return { operation };
	};

	const OBJECT = [STATUS, ORDINARY, CONFIG, EXPANDED] as const;
	let edits = 0;

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

		/**
		 * Reads the writable representation and its ETag for an edit. The response
		 * also updates shared state like any other read.
		 */
		async edit(id: InstanceIdentity): Promise<InstanceDraft> {
			let found: Awaited<ReturnType<typeof fetchInstanceWithEtag>> = null;
			let failure: unknown = null;
			const generation = core.currentGeneration;
			edits += 1;
			// Through the scheduler: events seen during the read still win.
			await core.read(instancesDefinition, {
				key: `edit#${edits} ${id.project}/${id.name}`,
				covers: () => false,
				async run(signal) {
					try {
						found = await fetchInstanceWithEtag(id, { signal });
					} catch (cause) {
						failure = cause;
						throw cause;
					}
					return (c, v) => {
						if (found) applyObject(c, found.instance, v);
						else c.store.markAbsent(instanceKey(id), v);
						reconcileMembership(c, id);
					};
				},
			});
			if (failure) throw failure;
			if (!core.isCurrent(generation))
				throw new IncusApiError("aborted", "The data layer was cleared");
			found = found as Awaited<ReturnType<typeof fetchInstanceWithEtag>>;
			if (!found)
				throw new IncusApiError(
					"not-found",
					`Instance "${id.name}" not found`,
					{
						status: 404,
					},
				);
			return { id, baseline: writableInstance(found.raw), etag: found.etag };
		},

		/**
		 * PUT based on the draft's baseline, conditional on its ETag. A 412 means the
		 * instance changed since the draft was read: `edit()` again to resolve it.
		 */
		async save(
			draft: InstanceDraft,
			change: (baseline: InstancePut) => InstancePut,
		): Promise<CommandResult> {
			const body = change(structuredClone(draft.baseline) as InstancePut);
			let ref: IncusOperationRef | null;
			try {
				ref = await putInstance(draft.id, body, draft.etag);
			} catch (cause) {
				throw commandError(cause);
			}
			// Whatever the response establishes, the previous object values are stale.
			const result = track(ref, draft.id, OBJECT);
			if (!ref) await affected(draft.id, OBJECT);
			else void affected(draft.id, OBJECT);
			return result;
		},

		/** start / stop / restart / freeze / unfreeze. Returns once accepted. */
		async action(
			id: InstanceIdentity,
			action: InstanceAction,
			opts: { force?: boolean; timeout?: number; stateful?: boolean } = {},
		): Promise<CommandResult> {
			let ref: IncusOperationRef;
			try {
				ref = await changeInstanceState(id, action, opts);
			} catch (cause) {
				throw commandError(cause);
			}
			return track(ref, id, [STATUS, RUNTIME]);
		},

		async delete(id: InstanceIdentity): Promise<CommandResult> {
			let ref: IncusOperationRef | null;
			try {
				ref = await deleteInstance(id);
			} catch (cause) {
				throw commandError(cause);
			}
			const gone = () => {
				const v = core.context.eventValidation();
				core.mutate((ctx) => {
					ctx.store.markAbsent(instanceKey(id), v);
					reconcileMembership(ctx, id);
				});
			};
			if (!ref) {
				gone();
				return { operation: null };
			}
			return track(ref, id, [], gone);
		},
	};
}

export type InstancesApi = ReturnType<typeof createInstancesApi>;
