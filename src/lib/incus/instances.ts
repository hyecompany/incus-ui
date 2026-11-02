// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	IncusApiError,
	type IncusOperationRef,
	incusFetch,
	incusRequest,
} from "./client.ts";
import type { ProjectScope } from "./project-scope.ts";
import { projectScopeQuery } from "./project-scope.ts";

/** Instance fields the UI can select (ordinary representation). */
export interface Instance {
	name: string;
	project: string;
	status: string;
	statusCode: number;
	type: string;
	/** Cluster member; Incus reports "none" when not clustered. */
	location: string;
	architecture: string;
	description: string;
	createdAt: string;
	lastUsedAt: string;
	profiles: readonly string[];
	ephemeral: boolean;
	stateful: boolean;
	/** Local configuration (instance keys only, without profiles). */
	config: Readonly<Record<string, string>>;
	/** Local devices (without profiles). */
	devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** Configuration after applying profiles; depends on every profile used. */
	expandedConfig: Readonly<Record<string, string>>;
	expandedDevices: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/* Runtime state (`/state`, sampled: no events describe these changes). */
	pid: number;
	processes: number;
	cpuUsage: number;
	memory: InstanceMemory;
	disk: Readonly<Record<string, { usage: number; total: number }>>;
	network: Readonly<Record<string, InstanceNetwork>>;
}

export interface InstanceMemory {
	usage: number;
	usagePeak: number;
	total: number;
	swapUsage: number;
	swapUsagePeak: number;
}

export interface InstanceNetwork {
	type: string;
	state: string;
	hwaddr: string;
	mtu: number;
	hostName: string;
	addresses: ReadonlyArray<{
		family: string;
		address: string;
		netmask: string;
		scope: string;
	}>;
	counters: {
		bytesReceived: number;
		bytesSent: number;
		packetsReceived: number;
		packetsSent: number;
	};
}

/** Fields of the runtime state representation. */
export type InstanceRuntime = Pick<
	Instance,
	| "status"
	| "statusCode"
	| "pid"
	| "processes"
	| "cpuUsage"
	| "memory"
	| "disk"
	| "network"
>;

export const RUNTIME_FIELDS = [
	"pid",
	"processes",
	"cpuUsage",
	"memory",
	"disk",
	"network",
] as const satisfies readonly (keyof Instance)[];

export type InstanceField = keyof Instance;

/** The ordinary object representation: everything except runtime state. */
export type InstanceObject = Omit<Instance, (typeof RUNTIME_FIELDS)[number]>;

/** The writable representation for PUT /1.0/instances/{name}. */
export interface InstancePut {
	architecture: string;
	config: Record<string, string>;
	devices: Record<string, Record<string, string>>;
	ephemeral: boolean;
	profiles: string[];
	stateful: boolean;
	description: string;
}

/** Statuses accepted as query criteria. */
export type InstanceStatus =
	| "Running"
	| "Stopped"
	| "Frozen"
	| "Error"
	| "Ready"
	| "Starting"
	| "Stopping"
	| "Freezing"
	| "Aborting";

export interface InstanceIdentity {
	project: string;
	name: string;
}

export interface InstanceCriteria {
	status?: InstanceStatus;
}

/** The server filter for criteria, or undefined for no filter. */
export function instanceFilter(criteria: InstanceCriteria): string | undefined {
	return criteria.status ? `status eq ${criteria.status}` : undefined;
}

/** Local evaluation equivalent to instanceFilter on the server. */
export function matchesCriteria(
	status: string | undefined,
	criteria: InstanceCriteria,
): boolean | undefined {
	if (!criteria.status) return true;
	if (status === undefined) return undefined;
	return status.toLowerCase() === criteria.status.toLowerCase();
}

type Fetch = { signal?: AbortSignal; fetchImpl?: typeof fetch };

function collectionQuery(scope: ProjectScope, criteria: InstanceCriteria) {
	return {
		...projectScopeQuery(scope, { allProjects: true, project: true }),
		filter: instanceFilter(criteria),
	};
}

/** `GET /1.0/instances` (recursion=0, optionally filtered): identities only. */
export async function fetchInstanceIdentities(
	scope: ProjectScope,
	criteria: InstanceCriteria,
	opts: Fetch = {},
): Promise<InstanceIdentity[]> {
	const raw = await incusRequest<unknown>("/1.0/instances", {
		...opts,
		query: collectionQuery(scope, criteria),
	});
	if (!Array.isArray(raw) || !raw.every((url) => typeof url === "string")) {
		throw malformed("Instance list is not an array of URLs");
	}
	return raw.map((url) => instanceIdentityFromUrl(url, scope));
}

/** `GET /1.0/instances?recursion=1` (optionally filtered): ordinary objects. */
export async function fetchInstanceObjects(
	scope: ProjectScope,
	criteria: InstanceCriteria,
	opts: Fetch = {},
): Promise<InstanceObject[]> {
	const raw = await incusRequest<unknown>("/1.0/instances", {
		...opts,
		query: { recursion: "1", ...collectionQuery(scope, criteria) },
	});
	if (!Array.isArray(raw)) {
		throw malformed("Instances response is not an array");
	}
	return raw.map((item, index) => parseInstanceObject(item, `index ${index}`));
}

/** `GET /1.0/instances?recursion=2`: objects with runtime state included. */
export async function fetchInstancesFull(
	scope: ProjectScope,
	criteria: InstanceCriteria,
	opts: Fetch = {},
): Promise<Array<{ instance: InstanceObject; state: InstanceRuntime | null }>> {
	const raw = await incusRequest<unknown>("/1.0/instances", {
		...opts,
		query: { recursion: "2", ...collectionQuery(scope, criteria) },
	});
	if (!Array.isArray(raw)) {
		throw malformed("Instances response is not an array");
	}
	return raw.map((item, index) => {
		const instance = parseInstanceObject(item, `index ${index}`);
		const state = isRecord(item) ? item.state : null;
		return {
			instance,
			state: isRecord(state) ? parseInstanceState(state, instance.name) : null,
		};
	});
}

const instancePath = (identity: InstanceIdentity) =>
	`/1.0/instances/${encodeURIComponent(identity.name)}`;

/** `GET /1.0/instances/{name}?project=`: one instance, or null if absent. */
export async function fetchInstance(
	identity: InstanceIdentity,
	opts: Fetch = {},
): Promise<InstanceObject | null> {
	return (await fetchInstanceWithEtag(identity, opts))?.instance ?? null;
}

/** Like fetchInstance, plus the ETag of the writable representation. */
export async function fetchInstanceWithEtag(
	identity: InstanceIdentity,
	opts: Fetch = {},
): Promise<{
	instance: InstanceObject;
	etag: string | null;
	raw: unknown;
} | null> {
	try {
		const response = await incusFetch<unknown>(instancePath(identity), {
			...opts,
			query: { project: identity.project },
		});
		return {
			instance: parseInstanceObject(response.metadata, `"${identity.name}"`),
			etag: response.etag,
			raw: response.metadata,
		};
	} catch (error) {
		if (error instanceof IncusApiError && error.kind === "not-found") {
			return null;
		}
		throw error;
	}
}

/** `GET /1.0/instances/{name}/state`; null if the instance does not exist. */
export async function fetchInstanceState(
	identity: InstanceIdentity,
	opts: Fetch = {},
): Promise<InstanceRuntime | null> {
	try {
		const raw = await incusRequest<unknown>(`${instancePath(identity)}/state`, {
			...opts,
			query: { project: identity.project },
		});
		return parseInstanceState(raw, identity.name);
	} catch (error) {
		if (error instanceof IncusApiError && error.kind === "not-found") {
			return null;
		}
		throw error;
	}
}

/** The writable baseline of an instance response (fields PUT replaces). */
export function writableInstance(raw: unknown): InstancePut {
	const value = isRecord(raw) ? raw : {};
	const instance = parseInstanceObject(raw, "baseline");
	return {
		architecture: instance.architecture,
		config: { ...instance.config },
		devices: Object.fromEntries(
			Object.entries(instance.devices).map(([k, v]) => [k, { ...v }]),
		),
		ephemeral: value.ephemeral === true,
		profiles: [...instance.profiles],
		stateful: value.stateful === true,
		description: instance.description,
	};
}

/** `PUT /1.0/instances/{name}` with If-Match. May be accepted as an operation. */
export async function putInstance(
	identity: InstanceIdentity,
	body: InstancePut,
	etag: string | null,
	opts: Fetch = {},
): Promise<IncusOperationRef | null> {
	const response = await incusFetch<unknown>(instancePath(identity), {
		...opts,
		method: "PUT",
		query: { project: identity.project },
		body,
		ifMatch: etag ?? undefined,
	});
	return response.operation;
}

export type InstanceAction =
	| "start"
	| "stop"
	| "restart"
	| "freeze"
	| "unfreeze";

/** `PUT /1.0/instances/{name}/state`: always a background operation. */
export async function changeInstanceState(
	identity: InstanceIdentity,
	action: InstanceAction,
	options: { force?: boolean; timeout?: number; stateful?: boolean } = {},
	opts: Fetch = {},
): Promise<IncusOperationRef> {
	const response = await incusFetch<unknown>(
		`${instancePath(identity)}/state`,
		{
			...opts,
			method: "PUT",
			query: { project: identity.project },
			body: {
				action,
				timeout: options.timeout ?? -1,
				force: options.force ?? false,
				stateful: options.stateful ?? false,
			},
		},
	);
	if (!response.operation)
		throw malformed("State change did not return an operation");
	return response.operation;
}

/** `DELETE /1.0/instances/{name}`: a background operation. */
export async function deleteInstance(
	identity: InstanceIdentity,
	opts: Fetch = {},
): Promise<IncusOperationRef | null> {
	const response = await incusFetch<unknown>(instancePath(identity), {
		...opts,
		method: "DELETE",
		query: { project: identity.project },
	});
	return response.operation;
}

const num = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;
const str = (value: unknown) => (typeof value === "string" ? value : "");

export function parseInstanceState(
	value: unknown,
	name: string,
): InstanceRuntime {
	if (!isRecord(value)) throw malformed(`State of "${name}" is not an object`);
	const memory = isRecord(value.memory) ? value.memory : {};
	const cpu = isRecord(value.cpu) ? value.cpu : {};
	const disk: Record<string, { usage: number; total: number }> = {};
	if (isRecord(value.disk)) {
		for (const [device, entry] of Object.entries(value.disk)) {
			const d = isRecord(entry) ? entry : {};
			disk[device] = { usage: num(d.usage), total: num(d.total) };
		}
	}
	const network: Record<string, InstanceNetwork> = {};
	if (isRecord(value.network)) {
		for (const [nic, entry] of Object.entries(value.network)) {
			const n = isRecord(entry) ? entry : {};
			const counters = isRecord(n.counters) ? n.counters : {};
			network[nic] = {
				type: str(n.type),
				state: str(n.state),
				hwaddr: str(n.hwaddr),
				mtu: num(n.mtu),
				hostName: str(n.host_name),
				addresses: (Array.isArray(n.addresses) ? n.addresses : [])
					.filter(isRecord)
					.map((a) => ({
						family: str(a.family),
						address: str(a.address),
						netmask: str(a.netmask),
						scope: str(a.scope),
					})),
				counters: {
					bytesReceived: num(counters.bytes_received),
					bytesSent: num(counters.bytes_sent),
					packetsReceived: num(counters.packets_received),
					packetsSent: num(counters.packets_sent),
				},
			};
		}
	}
	return {
		status: str(value.status),
		statusCode: num(value.status_code),
		pid: num(value.pid),
		processes: num(value.processes),
		cpuUsage: num(cpu.usage),
		memory: {
			usage: num(memory.usage),
			usagePeak: num(memory.usage_peak),
			total: num(memory.total),
			swapUsage: num(memory.swap_usage),
			swapUsagePeak: num(memory.swap_usage_peak),
		},
		disk,
		network,
	};
}

/** Identity from an instance URL. */
export function instanceIdentityFromUrl(
	url: string,
	scope: ProjectScope,
): InstanceIdentity {
	const [path = "", query = ""] = url.split("?");
	const prefix = "/1.0/instances/";
	if (!path.startsWith(prefix) || path.length === prefix.length) {
		throw malformed(`Unexpected instance URL: ${url}`);
	}
	const project =
		new URLSearchParams(query).get("project") ??
		(scope.kind === "project" ? scope.name : "default");
	return { project, name: decodeURIComponent(path.slice(prefix.length)) };
}

export function parseInstanceObject(
	value: unknown,
	at: string,
): InstanceObject {
	if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
		throw malformed(`Instance at ${at} has no name`);
	}
	const where = `Instance "${value.name}"`;
	const text = (field: string) => {
		const v = value[field] ?? "";
		if (typeof v !== "string")
			throw malformed(`${where} has an invalid ${field}`);
		return v;
	};
	const code = value.status_code ?? 0;
	if (typeof code !== "number" || !Number.isFinite(code)) {
		throw malformed(`${where} has an invalid status_code`);
	}
	const profiles = value.profiles ?? [];
	if (
		!Array.isArray(profiles) ||
		!profiles.every((p) => typeof p === "string")
	) {
		throw malformed(`${where} has invalid profiles`);
	}
	const map = (field: string): Record<string, string> => {
		const v = value[field] ?? {};
		if (!isRecord(v) || !Object.values(v).every((e) => typeof e === "string"))
			throw malformed(`${where} has an invalid ${field}`);
		return v as Record<string, string>;
	};
	const devicesOf = (field: string): Record<string, Record<string, string>> => {
		const v = value[field] ?? {};
		if (!isRecord(v)) throw malformed(`${where} has invalid ${field}`);
		const out: Record<string, Record<string, string>> = {};
		for (const [device, entry] of Object.entries(v)) {
			if (
				!isRecord(entry) ||
				!Object.values(entry).every((e) => typeof e === "string")
			)
				throw malformed(`${where} has an invalid device "${device}"`);
			out[device] = entry as Record<string, string>;
		}
		return out;
	};
	return {
		name: value.name,
		project: text("project") || "default",
		status: text("status"),
		statusCode: code,
		type: text("type"),
		location: text("location"),
		architecture: text("architecture"),
		description: text("description"),
		createdAt: text("created_at"),
		lastUsedAt: text("last_used_at"),
		profiles,
		ephemeral: value.ephemeral === true,
		stateful: value.stateful === true,
		config: map("config"),
		devices: devicesOf("devices"),
		expandedConfig: map("expanded_config"),
		expandedDevices: devicesOf("expanded_devices"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(message: string): IncusApiError {
	return new IncusApiError("malformed", message);
}
