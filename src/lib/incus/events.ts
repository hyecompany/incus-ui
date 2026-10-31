// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

// A websocket text frame is JSON. Lifecycle frames look like:
// { "type": "lifecycle", "timestamp": "...", "metadata": { "action": "instance-deleted", "source": "/1.0/instances/web-1?project=production", "requestor": { ... } } }
// Logging and operation frames use the same envelope with a different type.
// Extra lifecycle fields such as old_name are either on that metadata object or under metadata.context.
// source for an instance is /1.0/instances/{name}, not a nested path.

export type LifecycleEvent = {
	action: string;
	project: string;
	name: string;
	metadata: Record<string, unknown>;
};

export type LifecycleStore = {
	deleteInstance(project: string, name: string): void;
	noteCreated(project: string, name: string): void;
	invalidateAll(): void;
	beginRead?(project: string, names: readonly string[]): unknown;
	applyInstanceFields?(
		token: unknown,
		project: string,
		record: { name: string; status: string },
	): void;
	markCollectionFreshness?(
		project: string,
		status: string | null,
		fresh: boolean,
	): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function instanceIdentity(
	source: string,
): { name: string; project: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(source, "https://incus.local");
	} catch {
		return null;
	}
	const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
	if (parts.length !== 3 || parts[0] !== "1.0" || parts[1] !== "instances") {
		return null;
	}
	let name: string;
	try {
		name = decodeURIComponent(parts[2] ?? "");
	} catch {
		return null;
	}
	if (!name) return null;
	const project = parsed.searchParams.get("project");
	return { name, project: project && project.length > 0 ? project : "default" };
}

export function parseEventMessage(data: string): LifecycleEvent | null {
	let payload: unknown;
	try {
		payload = JSON.parse(data) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(payload) || payload.type !== "lifecycle") return null;
	const metadata = payload.metadata;
	if (!isRecord(metadata)) return null;
	if (
		typeof metadata.action !== "string" ||
		typeof metadata.source !== "string"
	) {
		return null;
	}
	const identity = instanceIdentity(metadata.source);
	if (!identity) return null;
	return {
		action: metadata.action,
		project: identity.project,
		name: identity.name,
		metadata,
	};
}

function previousName(metadata: Record<string, unknown>): string | undefined {
	if (typeof metadata.old_name === "string") return metadata.old_name;
	if (
		isRecord(metadata.context) &&
		typeof metadata.context.old_name === "string"
	) {
		return metadata.context.old_name;
	}
	return undefined;
}

function rememberCreated(
	store: LifecycleStore,
	project: string,
	name: string,
): void {
	store.noteCreated(project, name);
	if (typeof store.markCollectionFreshness === "function") {
		store.markCollectionFreshness(project, null, false);
		return;
	}
	store.invalidateAll();
}

function applyStatus(
	store: LifecycleStore,
	project: string,
	name: string,
	status: string,
): void {
	if (typeof store.applyInstanceFields !== "function") {
		store.invalidateAll();
		return;
	}
	const token =
		typeof store.beginRead === "function"
			? store.beginRead(project, [name])
			: undefined;
	store.applyInstanceFields(token, project, { name, status });
}

function applyRename(
	store: LifecycleStore,
	project: string,
	name: string,
	metadata: Record<string, unknown>,
): void {
	const oldName = previousName(metadata);
	if (oldName === undefined) {
		store.invalidateAll();
		return;
	}
	store.deleteInstance(project, oldName);
	store.noteCreated(project, name);
}

export function applyLifecycleEvent(
	store: LifecycleStore,
	event: LifecycleEvent,
): void {
	const { action, project, name, metadata } = event;
	switch (action) {
		case "instance-deleted":
			store.deleteInstance(project, name);
			return;
		case "instance-created":
			rememberCreated(store, project, name);
			return;
		case "instance-started":
			applyStatus(store, project, name, "Running");
			return;
		case "instance-stopped":
		case "instance-shutdown":
			applyStatus(store, project, name, "Stopped");
			return;
		case "instance-renamed":
			applyRename(store, project, name, metadata);
			return;
		default:
			if (action.startsWith("instance-")) store.invalidateAll();
	}
}

export function markEventCoverage(
	store: LifecycleStore,
	covered: boolean,
): void {
	if (!covered) store.invalidateAll();
}
