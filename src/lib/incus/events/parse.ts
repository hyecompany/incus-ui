// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	INCUS_EVENT_TYPES,
	type IncusEvent,
	type IncusEventType,
} from "./types.ts";

export type ParseResult =
	| { ok: true; event: IncusEvent }
	| { ok: false; reason: string };

const KNOWN_TYPES: ReadonlySet<string> = new Set(INCUS_EVENT_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates one websocket frame. `reason` is a fixed code naming the bad
 * field, so it can be logged without echoing the payload.
 */
export function parseEventFrame(data: unknown): ParseResult {
	let raw: unknown = data;
	if (typeof data === "string") {
		try {
			raw = JSON.parse(data);
		} catch {
			return { ok: false, reason: "not-json" };
		}
	}

	if (!isRecord(raw)) {
		return { ok: false, reason: "not-object" };
	}
	if (typeof raw.type !== "string" || !KNOWN_TYPES.has(raw.type)) {
		return { ok: false, reason: "type" };
	}
	if (typeof raw.timestamp !== "string") {
		return { ok: false, reason: "timestamp" };
	}
	if (raw.metadata === undefined) {
		return { ok: false, reason: "metadata" };
	}

	const event: IncusEvent = {
		type: raw.type as IncusEventType,
		timestamp: raw.timestamp,
		metadata: raw.metadata,
	};
	if (raw.project !== undefined) {
		if (typeof raw.project !== "string") {
			return { ok: false, reason: "project" };
		}
		event.project = raw.project;
	}
	if (raw.location !== undefined) {
		if (typeof raw.location !== "string") {
			return { ok: false, reason: "location" };
		}
		event.location = raw.location;
	}

	return { ok: true, event };
}
