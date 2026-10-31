// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import {
	IncusRequestError,
	type IncusResult,
	incusRequest,
} from "./transport.ts";

export type OperationRecord = {
	id: string;
	url: string;
	status: string;
	statusCode: number;
	err: string;
	mayCancel: boolean;
	initiatedHere: boolean;
	monitoring: boolean;
};

export type OperationRegistry = {
	register(record: OperationRecord): void;
	update(id: string, partial: Partial<Omit<OperationRecord, "id">>): void;
	get(id: string): OperationRecord | undefined;
	list(): OperationRecord[];
	subscribe(listener: () => void): () => void;
	clear(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOperation(metadata: unknown): {
	status: string;
	statusCode: number;
	err: string;
	mayCancel: boolean;
} {
	if (!isRecord(metadata) || typeof metadata.status_code !== "number") {
		throw new Error("Operation response did not include a status code");
	}
	return {
		status: typeof metadata.status === "string" ? metadata.status : "",
		statusCode: metadata.status_code,
		err: typeof metadata.err === "string" ? metadata.err : "",
		mayCancel: metadata.may_cancel === true,
	};
}

function operationPath(id: string): string {
	return `/1.0/operations/${encodeURIComponent(id)}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const reason: unknown = signal.reason;
	if (reason instanceof Error) throw reason;
	throw new DOMException("The operation was aborted", "AbortError");
}

export function createOperationRegistry(): OperationRegistry {
	const records = new Map<string, OperationRecord>();
	const listeners = new Set<() => void>();

	function emit(): void {
		for (const listener of [...listeners]) listener();
	}

	return {
		register(record) {
			records.set(record.id, { ...record });
			emit();
		},
		update(id, partial) {
			const current = records.get(id);
			if (!current) return;
			records.set(id, { ...current, ...partial, id: current.id });
			emit();
		},
		get(id) {
			const record = records.get(id);
			return record ? { ...record } : undefined;
		},
		list() {
			return [...records.values()].map((record) => ({ ...record }));
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clear() {
			records.clear();
			emit();
		},
	};
}

export async function waitForOperation(
	registry: OperationRegistry,
	id: string,
	options: { signal?: AbortSignal; request?: typeof incusRequest } = {},
): Promise<OperationRecord> {
	const request = options.request ?? incusRequest;
	const path = operationPath(id);

	for (;;) {
		throwIfAborted(options.signal);
		let result: IncusResult<unknown>;
		try {
			result = await request<unknown>(path, {
				method: "GET",
				signal: options.signal,
			});
		} catch (error) {
			if (error instanceof IncusRequestError) {
				registry.update(id, { monitoring: false });
			}
			throw error;
		}

		const fields = readOperation(result.metadata);
		const current = registry.get(id);
		const next: OperationRecord = {
			id,
			url: current?.url || path,
			status: fields.status,
			statusCode: fields.statusCode,
			err: fields.err,
			mayCancel: fields.mayCancel,
			initiatedHere: current?.initiatedHere ?? false,
			monitoring: true,
		};
		if (current) registry.update(id, next);
		else registry.register(next);

		const stored = registry.get(id) ?? next;
		if (stored.statusCode >= 200) return stored;
	}
}

export async function cancelOperation(
	registry: OperationRegistry,
	id: string,
	request: typeof incusRequest = incusRequest,
): Promise<void> {
	const path = registry.get(id)?.url || operationPath(id);
	try {
		await request(path, { method: "DELETE" });
	} catch (error) {
		if (error instanceof IncusRequestError && error.status === 404) return;
		throw error;
	}
}
