// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { buildIncusUrl } from "../client.ts";
import type { ProjectScope } from "../project-scope.ts";
import { projectScopeKey, projectScopeQuery } from "../project-scope.ts";
import {
	type BackoffOptions,
	backoffDelay,
	DEFAULT_BACKOFF,
} from "./backoff.ts";
import { parseEventFrame } from "./parse.ts";
import type {
	ConnectionState,
	EventStream,
	EventsError,
	IncusEvent,
	IncusEventType,
	RecoveryNotice,
	ScopeStatus,
	Subscription,
} from "./types.ts";

export const EVENTS_PATH = "/1.0/events";
export const DEFAULT_MAX_ATTEMPTS = 10;

const STREAM_TYPES: Record<EventStream, readonly IncusEventType[]> = {
	core: ["lifecycle", "operation"],
	logging: ["logging"],
};

/** Streams a subscriber needs, given the event types it asked for. */
export function streamsFor(types: readonly IncusEventType[]): EventStream[] {
	const streams: EventStream[] = [];
	for (const stream of ["core", "logging"] as const) {
		if (types.some((type) => STREAM_TYPES[stream].includes(type))) {
			streams.push(stream);
		}
	}
	return streams;
}

/** Identity of one socket: a scope plus a stream. */
export function channelKey(scope: ProjectScope, stream: EventStream): string {
	return `${projectScopeKey(scope)}|${stream}`;
}

/** Builds the events path for one stream. */
export function buildEventsPath(
	scope: ProjectScope,
	stream: EventStream,
): string {
	return buildIncusUrl(EVENTS_PATH, {
		type: STREAM_TYPES[stream].join(","),
		...projectScopeQuery(scope, { allProjects: true, project: true }),
	});
}

/** Converts an http(s) origin plus path into the matching ws(s) URL. */
export function toWebSocketUrl(origin: string, path: string): string {
	const url = new URL(path, origin);
	if (url.protocol === "https:") {
		url.protocol = "wss:";
	} else if (url.protocol === "http:") {
		url.protocol = "ws:";
	} else {
		throw new Error(`Unsupported origin scheme for events: ${url.protocol}`);
	}
	return url.toString();
}

/** The subset of WebSocket the manager uses. Injected so tests can fake it. */
export interface WebSocketLike {
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	close(code?: number, reason?: string): void;
}

export interface IncusEventsManagerDeps {
	createSocket(url: string): WebSocketLike;
	/** Page origin; the socket URL and the HTTP probe are derived from it. */
	origin: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	setTimeout?: (callback: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	random?: () => number;
	backoff?: BackoffOptions;
	maxAttempts?: number;
}

interface Channel {
	key: string;
	scope: ProjectScope;
	stream: EventStream;
	/** Refcount per subscription object; a duplicate counts but delivers once. */
	subscribers: Map<Subscription, number>;
	state: ConnectionState;
	generation: number;
	lastError?: EventsError;
	interruptedAt?: number;
	socket: WebSocketLike | null;
	/** Bumped on every connect and teardown so late callbacks can be ignored. */
	socketToken: number;
	timer: unknown | null;
	probe: AbortController | null;
	attempts: number;
	connectedOnce: boolean;
	/** True from the first loss after a connection until the next open. */
	interrupted: boolean;
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

/** One socket per (scope, stream), refcounted by subscribers. */
export class IncusEventsManager {
	private readonly deps: IncusEventsManagerDeps;
	private readonly origin: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly random: () => number;
	private readonly backoff: BackoffOptions;
	private readonly maxAttempts: number;

	private readonly channels = new Map<string, Channel>();
	private readonly statuses = new Map<string, ScopeStatus>();
	private readonly statusListeners = new Set<(status: ScopeStatus) => void>();
	private disposed = false;

	constructor(deps: IncusEventsManagerDeps) {
		this.deps = deps;
		this.origin = deps.origin;
		this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
		this.now = deps.now ?? (() => Date.now());
		this.setTimer =
			deps.setTimeout ??
			((callback, ms) => globalThis.setTimeout(callback, ms));
		this.clearTimer =
			deps.clearTimeout ??
			((handle) =>
				globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.random = deps.random ?? Math.random;
		this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
		this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	}

	/** Subscribes on each stream the types need; returns an unsubscribe function. */
	subscribe(subscription: Subscription): () => void {
		if (this.disposed) {
			throw new Error("IncusEventsManager is disposed");
		}

		const joined: Channel[] = [];
		for (const stream of streamsFor(subscription.types)) {
			const key = channelKey(subscription.scope, stream);
			let channel = this.channels.get(key);
			if (!channel) {
				channel = this.createChannel(key, subscription.scope, stream);
				this.channels.set(key, channel);
			}
			channel.subscribers.set(
				subscription,
				(channel.subscribers.get(subscription) ?? 0) + 1,
			);
			joined.push(channel);
		}

		for (const channel of joined) {
			const isOpening =
				channel.socket === null &&
				channel.timer === null &&
				channel.probe === null &&
				channel.state !== "connected";
			if (isOpening) {
				// A new subscriber is a user-driven retry, so it starts a fresh budget.
				channel.attempts = 0;
				this.connect(channel);
			}
		}

		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			for (const channel of joined) {
				this.release(channel, subscription);
			}
		};
	}

	/** Status of one stream of a scope. Defaults to the core stream. */
	getStatus(scope: ProjectScope, stream: EventStream = "core"): ScopeStatus {
		const key = channelKey(scope, stream);
		let status = this.statuses.get(key);
		if (!status) {
			// Cached so useSyncExternalStore sees a stable snapshot.
			status = { scope, stream, state: "idle", generation: 0 };
			this.statuses.set(key, status);
		}
		return status;
	}

	onStatus(callback: (status: ScopeStatus) => void): () => void {
		this.statusListeners.add(callback);
		return () => {
			this.statusListeners.delete(callback);
		};
	}

	/** Closes every socket, cancels timers and probes, and drops subscribers and status. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const channel of this.channels.values()) {
			this.teardown(channel);
		}
		this.channels.clear();
		this.statuses.clear();
		this.statusListeners.clear();
	}

	private createChannel(
		key: string,
		scope: ProjectScope,
		stream: EventStream,
	): Channel {
		return {
			key,
			scope,
			stream,
			subscribers: new Map(),
			state: "idle",
			generation: this.statuses.get(key)?.generation ?? 0,
			socket: null,
			socketToken: 0,
			timer: null,
			probe: null,
			attempts: 0,
			connectedOnce: false,
			interrupted: false,
		};
	}

	private release(channel: Channel, subscription: Subscription): void {
		const count = channel.subscribers.get(subscription) ?? 0;
		if (count > 1) {
			channel.subscribers.set(subscription, count - 1);
			return;
		}
		channel.subscribers.delete(subscription);

		if (
			channel.subscribers.size === 0 &&
			this.channels.get(channel.key) === channel
		) {
			this.teardown(channel);
			this.channels.delete(channel.key);
			this.setStatus(channel);
		}
	}

	private isCurrent(channel: Channel, token: number): boolean {
		return (
			!this.disposed &&
			this.channels.get(channel.key) === channel &&
			channel.socketToken === token
		);
	}

	private connect(channel: Channel): void {
		if (this.disposed || channel.subscribers.size === 0) {
			return;
		}

		const token = ++channel.socketToken;
		this.setState(
			channel,
			channel.attempts === 0 ? "connecting" : "reconnecting",
		);

		let socket: WebSocketLike;
		try {
			socket = this.deps.createSocket(
				toWebSocketUrl(
					this.origin,
					buildEventsPath(channel.scope, channel.stream),
				),
			);
		} catch (error) {
			this.onLoss(
				channel,
				{ kind: "network", message: errorName(error) },
				false,
			);
			return;
		}

		let opened = false;
		channel.socket = socket;

		socket.onopen = () => {
			if (!this.isCurrent(channel, token)) {
				return;
			}
			opened = true;
			this.handleOpen(channel);
		};

		socket.onmessage = (event) => {
			if (!this.isCurrent(channel, token)) {
				return;
			}
			const parsed = parseEventFrame(event.data);
			if (!parsed.ok) {
				console.warn(`Dropped invalid Incus event frame: ${parsed.reason}`);
				return;
			}
			this.dispatch(channel, parsed.event);
		};

		socket.onclose = (event) => {
			if (!this.isCurrent(channel, token)) {
				return;
			}
			channel.socket = null;
			if (!opened) {
				// WebSockets hide the HTTP status, so probe to tell auth failures apart.
				void this.probe(channel, token);
				return;
			}
			this.onLoss(
				channel,
				{ kind: "closed", message: `socket closed (code ${event.code})` },
				false,
			);
		};

		socket.onerror = () => {
			// Browsers always follow an error with close, which drives the state.
		};
	}

	private handleOpen(channel: Channel): void {
		const restored = channel.interrupted;
		channel.attempts = 0;
		channel.connectedOnce = true;
		channel.lastError = undefined;
		channel.interrupted = false;
		if (restored) {
			channel.generation += 1;
			channel.interruptedAt = undefined;
		}
		this.setState(channel, "connected");

		if (restored) {
			const notice: RecoveryNotice = {
				scope: channel.scope,
				stream: channel.stream,
				generation: channel.generation,
				reason: "reconnected",
			};
			for (const subscription of [...channel.subscribers.keys()]) {
				try {
					subscription.onRecovery?.(notice);
				} catch (error) {
					console.warn(`Incus recovery listener failed: ${errorName(error)}`);
				}
			}
		}
	}

	private async probe(channel: Channel, token: number): Promise<void> {
		const controller = new AbortController();
		channel.probe = controller;
		let status: number | null = null;
		try {
			const response = await this.fetchImpl(
				buildEventsPath(channel.scope, channel.stream),
				{
					method: "GET",
					credentials: "same-origin",
					signal: controller.signal,
				},
			);
			status = response.status;
			await response.body?.cancel().catch(() => undefined);
		} catch {
			status = null;
		}

		if (!this.isCurrent(channel, token)) {
			return;
		}
		channel.probe = null;

		if (status === 401 || status === 403) {
			this.onLoss(
				channel,
				{
					kind: "forbidden",
					message: `events endpoint refused the session (HTTP ${status})`,
				},
				true,
			);
			return;
		}
		// HTTP 400 on a plain GET means the endpoint is reachable and refused the upgrade.
		let message = `probe returned HTTP ${status}`;
		if (status === null) {
			message = "probe failed";
		} else if (status === 400) {
			message = "events endpoint reachable but refused the upgrade (HTTP 400)";
		}
		this.onLoss(channel, { kind: "network", message }, false);
	}

	/** Single place where a failed or closed connection is handled. */
	private onLoss(
		channel: Channel,
		error: EventsError,
		terminal: boolean,
	): void {
		channel.socket = null;
		channel.lastError = error;
		channel.attempts += 1;

		const beganInterruption = channel.connectedOnce && !channel.interrupted;
		if (beganInterruption) {
			channel.interrupted = true;
			channel.interruptedAt = this.now();
		}

		if (terminal || channel.attempts >= this.maxAttempts) {
			this.setState(channel, "failed");
		} else {
			this.setState(channel, "reconnecting");
			const delay = backoffDelay(
				channel.attempts - 1,
				this.random,
				this.backoff,
			);
			const token = channel.socketToken;
			channel.timer = this.setTimer(() => {
				channel.timer = null;
				if (this.isCurrent(channel, token)) {
					this.connect(channel);
				}
			}, delay);
		}

		if (beganInterruption) {
			const status = this.snapshot(channel);
			for (const subscription of [...channel.subscribers.keys()]) {
				try {
					subscription.onInterrupted?.(status);
				} catch (error) {
					console.warn(
						`Incus interruption listener failed: ${errorName(error)}`,
					);
				}
			}
		}
	}

	private dispatch(channel: Channel, event: IncusEvent): void {
		for (const subscription of [...channel.subscribers.keys()]) {
			if (this.disposed) {
				return;
			}
			// A listener may have unsubscribed while earlier listeners ran.
			if (!channel.subscribers.has(subscription)) {
				continue;
			}
			if (!subscription.types.includes(event.type)) {
				continue;
			}
			try {
				subscription.onEvent(event);
			} catch (error) {
				console.warn(`Incus event listener failed: ${errorName(error)}`);
			}
		}
	}

	private teardown(channel: Channel): void {
		channel.socketToken += 1;
		if (channel.timer !== null) {
			this.clearTimer(channel.timer);
			channel.timer = null;
		}
		channel.probe?.abort();
		channel.probe = null;
		const socket = channel.socket;
		channel.socket = null;
		if (socket) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onclose = null;
			socket.onerror = null;
			try {
				socket.close(1000);
			} catch {
				// Already closed or closing; nothing else to release.
			}
		}
		channel.state = "idle";
		channel.attempts = 0;
		channel.interrupted = false;
		channel.interruptedAt = undefined;
		channel.lastError = undefined;
	}

	private setState(channel: Channel, state: ConnectionState): void {
		channel.state = state;
		this.setStatus(channel);
	}

	private snapshot(channel: Channel): ScopeStatus {
		const status: ScopeStatus = {
			scope: channel.scope,
			stream: channel.stream,
			state: channel.state,
			generation: channel.generation,
		};
		if (channel.lastError) {
			status.lastError = channel.lastError;
		}
		if (channel.interruptedAt !== undefined) {
			status.interruptedAt = channel.interruptedAt;
		}
		return status;
	}

	private setStatus(channel: Channel): void {
		if (this.disposed) {
			return;
		}
		const status = this.snapshot(channel);
		this.statuses.set(channel.key, status);
		for (const listener of [...this.statusListeners]) {
			try {
				listener(status);
			} catch (error) {
				console.warn(`Incus status listener failed: ${errorName(error)}`);
			}
		}
	}
}
