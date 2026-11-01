// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { IncusEvent } from "./events/types.ts";

/**
 * A resource change described by an Incus lifecycle event, e.g.
 * `instance-created` with source `/1.0/instances/c1?project=web`.
 */
export interface ResourceChange {
	/** Full lifecycle action, e.g. "instance-renamed" or "storage-volume-created". */
	action: string;
	/** Last segment of the action: "created", "deleted", "updated", "renamed", "started", ... */
	verb: string;
	/** Top-level API collection from the source path, e.g. "instances", "storage-pools". */
	collection: string;
	/** Source path without the query string, e.g. "/1.0/instances/c1". */
	path: string;
	/** Second path segment when present (the top-level resource name). */
	name?: string;
	/** Project and cluster member exactly as Incus sent them; never inferred. */
	project?: string;
	location?: string;
}

const API_PREFIX = "/1.0/";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a lifecycle event into a ResourceChange. Returns null for other event
 * types and for lifecycle events without a usable `/1.0/...` source.
 */
export function parseResourceChange(event: IncusEvent): ResourceChange | null {
	if (event.type !== "lifecycle" || !isRecord(event.metadata)) {
		return null;
	}

	const { action, source } = event.metadata;
	if (
		typeof action !== "string" ||
		action === "" ||
		typeof source !== "string"
	) {
		return null;
	}

	const path = source.split("?")[0] ?? "";
	if (!path.startsWith(API_PREFIX)) {
		return null;
	}

	const segments = path.slice(API_PREFIX.length).split("/").filter(Boolean);
	const collection = segments[0];
	if (!collection) {
		return null;
	}

	const change: ResourceChange = {
		action,
		verb: action.slice(action.lastIndexOf("-") + 1),
		collection,
		path,
	};
	if (segments[1]) {
		change.name = safeDecode(segments[1]);
	}
	if (event.project !== undefined) {
		change.project = event.project;
	}
	if (event.location !== undefined) {
		change.location = event.location;
	}
	return change;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
