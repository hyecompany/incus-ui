// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { ProjectScope } from "../project-scope.ts";

export type IncusEventType = "lifecycle" | "operation" | "logging";

export const INCUS_EVENT_TYPES: readonly IncusEventType[] = [
	"lifecycle",
	"operation",
	"logging",
];

/** One frame from `/1.0/events`. */
export interface IncusEvent<M = unknown> {
	type: IncusEventType;
	timestamp: string;
	metadata: M;
	project?: string;
	location?: string;
}

/** Each scope has two sockets. */
export type EventStream = "core" | "logging";

export type ConnectionState =
	| "idle"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "failed";

export type EventsErrorKind = "forbidden" | "network" | "closed";

export interface EventsError {
	kind: EventsErrorKind;
	message: string;
}

export interface ScopeStatus {
	scope: ProjectScope;
	stream?: EventStream;
	state: ConnectionState;
	generation: number;
	lastError?: EventsError;
	interruptedAt?: number;
}

/** The transport was restored after an interruption. */
export interface RecoveryNotice {
	scope: ProjectScope;
	stream?: EventStream;
	generation: number;
	reason: "reconnected";
}

export interface Subscription {
	types: IncusEventType[];
	scope: ProjectScope;
	onEvent(event: IncusEvent): void;
	onRecovery?(notice: RecoveryNotice): void;
	onInterrupted?(status: ScopeStatus): void;
}
