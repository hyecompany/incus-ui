// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { ProjectScope } from "../project-scope.ts";

export type IncusEventType = "lifecycle" | "operation" | "logging";

export const INCUS_EVENT_TYPES: readonly IncusEventType[] = [
	"lifecycle",
	"operation",
	"logging",
];

/**
 * One frame from `/1.0/events`. `project` and `location` are copied only when
 * Incus sent them; they are never inferred from `metadata`.
 */
export interface IncusEvent<M = unknown> {
	type: IncusEventType;
	timestamp: string;
	metadata: M;
	project?: string;
	location?: string;
}

/**
 * Each scope has two sockets. `core` carries lifecycle and operation events.
 * `logging` is separate because Incus can restrict it to privileged users, and
 * a refusal there must not take core delivery down with it.
 */
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

/**
 * The transport was restored after an interruption. Incus does not replay
 * events, so subscribers MAY have missed events and must reconcile themselves.
 */
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
