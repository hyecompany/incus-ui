// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { IncusEvent } from "./events/types.ts";
import { parseResourceChange } from "./resource-events.ts";

export type NoticeTone = "loading" | "success" | "error" | "info";

export interface Notice {
	/** Stable id: notices with the same id replace each other in place. */
	id: string;
	tone: NoticeTone;
	title: string;
	description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** "/1.0/instances/web?project=prod" -> "prod/web" (project only if not default). */
function resourceLabel(url: string): string {
	const [path = "", query = ""] = url.split("?");
	const name = decodeURIComponent(path.split("/").filter(Boolean).at(-1) ?? "");
	const project = new URLSearchParams(query).get("project");
	return project && project !== "default" ? `${project}/${name}` : name;
}

/** First resource the operation touches, preferring instances. */
function operationTarget(op: Record<string, unknown>): string | undefined {
	if (!isRecord(op.resources)) return undefined;
	const groups = Object.entries(op.resources).sort(([a], [b]) =>
		a === "instances" ? -1 : b === "instances" ? 1 : 0,
	);
	for (const [, urls] of groups) {
		if (Array.isArray(urls) && typeof urls[0] === "string") {
			return resourceLabel(urls[0]);
		}
	}
	return undefined;
}

/** Progress text from operation metadata (`*_progress` or `progress.percent`). */
export function operationProgress(
	op: Record<string, unknown>,
): string | undefined {
	const meta = op.metadata;
	if (!isRecord(meta)) return undefined;
	for (const [key, value] of Object.entries(meta)) {
		if (key.endsWith("_progress") && typeof value === "string" && value) {
			return value;
		}
	}
	if (isRecord(meta.progress)) {
		const percent = meta.progress.percent;
		const stage = str(meta.progress, "stage");
		if (typeof percent === "string" || typeof percent === "number") {
			return `${stage ? `${stage}: ` : ""}${percent}%`;
		}
	}
	return undefined;
}

/** Toast for an operation, keyed by operation id so it updates in place. */
export function noticeForOperation(event: IncusEvent): Notice | null {
	if (event.type !== "operation" || !isRecord(event.metadata)) return null;
	const op = event.metadata;
	const id = str(op, "id");
	if (!id) return null;
	const target = operationTarget(op);
	const title = [str(op, "description") ?? "Operation", target]
		.filter(Boolean)
		.join(": ");
	const where =
		event.project && event.project !== "default" ? ` · ${event.project}` : "";
	switch (str(op, "status")) {
		case "Pending":
		case "Running":
			return {
				id: `op:${id}`,
				tone: "loading",
				title,
				description: `${operationProgress(op) ?? str(op, "status")}${where}`,
			};
		case "Success":
			return {
				id: `op:${id}`,
				tone: "success",
				title,
				description: `Completed${where}`,
			};
		case "Failure":
			return {
				id: `op:${id}`,
				tone: "error",
				title,
				description: str(op, "err") ?? "Operation failed",
			};
		case "Cancelled":
			return { id: `op:${id}`, tone: "info", title, description: "Cancelled" };
		default:
			return null;
	}
}

const ENTITY_LABELS: Record<string, string> = {
	instance: "Instance",
	"instance-snapshot": "Snapshot",
	"instance-backup": "Backup",
	image: "Image",
	"image-alias": "Image alias",
	network: "Network",
	"network-acl": "Network ACL",
	"network-zone": "Network zone",
	profile: "Profile",
	project: "Project",
	"storage-pool": "Storage pool",
	"storage-volume": "Storage volume",
	"storage-volume-snapshot": "Volume snapshot",
	"storage-bucket": "Storage bucket",
};

const VERB_LABELS: Record<string, { text: string; tone: NoticeTone }> = {
	created: { text: "created", tone: "success" },
	deleted: { text: "deleted", tone: "info" },
	renamed: { text: "renamed", tone: "info" },
	updated: { text: "updated", tone: "info" },
	started: { text: "started", tone: "success" },
	stopped: { text: "stopped", tone: "info" },
	restarted: { text: "restarted", tone: "success" },
	paused: { text: "paused", tone: "info" },
	resumed: { text: "resumed", tone: "success" },
	shutdown: { text: "shut down", tone: "info" },
	restored: { text: "restored", tone: "success" },
};

/** Toast for a resource lifecycle change, or null for noisy actions. */
export function noticeForLifecycle(event: IncusEvent): Notice | null {
	const change = parseResourceChange(event);
	if (!change) return null;
	const verb = VERB_LABELS[change.verb];
	const entity =
		ENTITY_LABELS[change.action.slice(0, -(change.verb.length + 1))];
	if (!verb || !entity) return null;
	const name = decodeURIComponent(
		change.path.split("/").filter(Boolean).at(-1) ?? "",
	);
	const project =
		change.project && change.project !== "default"
			? ` in ${change.project}`
			: "";
	const location =
		change.location && change.location !== "none"
			? ` on ${change.location}`
			: "";
	return {
		id: `lc:${change.action}:${change.path}:${event.timestamp}`,
		tone: verb.tone,
		title: `${entity} ${verb.text}`,
		description: `${name}${project}${location}`,
	};
}
