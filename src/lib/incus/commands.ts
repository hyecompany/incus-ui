// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import {
	cancelOperation,
	type OperationRecord,
	type OperationRegistry,
	waitForOperation,
} from "./operations.ts";
import { type IncusResult, incusPath, incusRequest } from "./transport.ts";

export type InstanceStateAction =
	| "start"
	| "stop"
	| "restart"
	| "freeze"
	| "unfreeze";

export type TrackedOperation = {
	id: string;
	url: string;
	wait: () => Promise<OperationRecord>;
	cancel: () => Promise<void>;
};

export type InstanceStateChange = {
	accepted: true;
	operation: TrackedOperation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function instanceUrl(
	name: string,
	project: string | undefined,
	suffix = "",
): string {
	const path = `/1.0/instances/${encodeURIComponent(name)}${suffix}`;
	if (!project || project === "default") return path;
	return incusPath(path, { project });
}

function operationIdentity(
	operation: string,
): { id: string; url: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(operation, "https://incus.local");
	} catch {
		return null;
	}
	const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
	if (parts.length !== 3 || parts[0] !== "1.0" || parts[1] !== "operations") {
		return null;
	}
	let id: string;
	try {
		id = decodeURIComponent(parts[2] ?? "");
	} catch {
		return null;
	}
	if (!id) return null;
	return { id, url: parsed.pathname };
}

function seededOperation(
	metadata: unknown,
): Pick<OperationRecord, "status" | "statusCode" | "err" | "mayCancel"> {
	if (!isRecord(metadata) || typeof metadata.status_code !== "number") {
		return { status: "", statusCode: 0, err: "", mayCancel: false };
	}
	return {
		status: typeof metadata.status === "string" ? metadata.status : "",
		statusCode: metadata.status_code,
		err: typeof metadata.err === "string" ? metadata.err : "",
		mayCancel: metadata.may_cancel === true,
	};
}

export async function changeInstanceState(
	name: string,
	action: InstanceStateAction,
	options: {
		project?: string;
		registry: OperationRegistry;
		request?: typeof incusRequest;
	},
): Promise<InstanceStateChange> {
	const request = options.request ?? incusRequest;
	const result = await request<unknown>(
		instanceUrl(name, options.project, "/state"),
		{
			method: "POST",
			body: { action, timeout: 30, force: false, stateful: false },
		},
	);
	const identity = operationIdentity(result.operation);
	if (result.type !== "async" || !identity) {
		throw new Error("Instance state change did not return an operation");
	}

	const seeded = seededOperation(result.metadata);
	options.registry.register({
		id: identity.id,
		url: identity.url,
		status: seeded.status,
		statusCode: seeded.statusCode,
		err: seeded.err,
		mayCancel: seeded.mayCancel,
		initiatedHere: true,
		monitoring: true,
	});

	const id = identity.id;
	return {
		accepted: true,
		operation: {
			id,
			url: identity.url,
			wait: () => waitForOperation(options.registry, id, { request }),
			cancel: () => cancelOperation(options.registry, id, request),
		},
	};
}

export async function putInstance(
	name: string,
	body: unknown,
	etag: string,
	options: { project?: string; request?: typeof incusRequest } = {},
): Promise<IncusResult<unknown>> {
	const request = options.request ?? incusRequest;
	return request<unknown>(instanceUrl(name, options.project), {
		method: "PUT",
		body,
		headers: { "If-Match": etag },
	});
}
