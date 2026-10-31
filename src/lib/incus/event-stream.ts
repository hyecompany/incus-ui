// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

export type IncusEvent = {
	type: "lifecycle" | "operation" | "logging";
	timestamp: string;
	location: string;
	project: string;
	metadata: Record<string, unknown>;
};

const INCUS_EVENT_TYPES = new Set(["lifecycle", "operation", "logging"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectFromLifecycleSource(source: string): string {
	try {
		const parsed = new URL(source, "https://incus.local");
		const project = parsed.searchParams.get("project");
		return project && project.length > 0 ? project : "default";
	} catch {
		return "default";
	}
}

function projectForEvent(
	type: "lifecycle" | "operation" | "logging",
	metadata: Record<string, unknown>,
): string {
	if (type === "lifecycle") {
		if (typeof metadata.source !== "string") return "default";
		return projectFromLifecycleSource(metadata.source);
	}
	if (type === "operation") {
		if (typeof metadata.project === "string" && metadata.project.length > 0) {
			return metadata.project;
		}
		return "default";
	}
	const context = metadata.context;
	if (
		isRecord(context) &&
		typeof context.project === "string" &&
		context.project.length > 0
	) {
		return context.project;
	}
	return "default";
}

export function parseIncusEvent(data: string): IncusEvent | null {
	let payload: unknown;
	try {
		payload = JSON.parse(data) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(payload)) return null;
	if (typeof payload.type !== "string") return null;
	if (!INCUS_EVENT_TYPES.has(payload.type)) return null;
	if (typeof payload.timestamp !== "string") return null;
	const metadata = payload.metadata;
	if (!isRecord(metadata)) return null;
	const type = payload.type as "lifecycle" | "operation" | "logging";
	const location = typeof payload.location === "string" ? payload.location : "";
	return {
		type,
		timestamp: payload.timestamp,
		location,
		project: projectForEvent(type, metadata),
		metadata,
	};
}

export function defaultIncusEventsUrl(): string {
	return "/1.0/events?type=lifecycle,operation,logging&all-projects=true";
}

function browserWebSocketUrl(path: string): string {
	if (path.startsWith("ws:") || path.startsWith("wss:")) return path;
	if (typeof location !== "undefined") {
		const protocol = location.protocol === "https:" ? "wss:" : "ws:";
		return `${protocol}//${location.host}${path}`;
	}
	return path;
}

export type EventDelivery = "connecting" | "live" | "interrupted" | "closed";

export type WebSocketLike = {
	addEventListener(
		type: "open" | "message" | "close",
		listener: (event: unknown) => void,
	): void;
	close(): void;
};

export type EventStream = {
	start(): void;
	stop(): void;
	delivery(): EventDelivery;
	needsReconcile(): boolean;
	noteReconciled(): void;
	subscribe(listener: (event: IncusEvent) => void): () => void;
	subscribeDelivery(listener: () => void): () => void;
};

function messageData(event: unknown): string {
	if (typeof event === "object" && event !== null && "data" in event) {
		return String((event as { data: unknown }).data);
	}
	return String(event);
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
	const id = setTimeout(callback, delayMs);
	return () => {
		clearTimeout(id);
	};
}

export function createEventStream(options?: {
	url?: () => string;
	webSocket?: new (url: string) => WebSocketLike;
	reconnectDelayMs?: number;
	schedule?: (callback: () => void, delayMs: number) => () => void;
}): EventStream {
	const resolveUrl = options?.url ?? defaultIncusEventsUrl;
	const WebSocketCtor =
		options?.webSocket ??
		(typeof WebSocket !== "undefined"
			? (WebSocket as unknown as new (
					url: string,
				) => WebSocketLike)
			: undefined);
	const reconnectDelayMs = options?.reconnectDelayMs ?? 2000;
	const schedule = options?.schedule ?? defaultSchedule;

	let delivery: EventDelivery = "closed";
	let reconcile = false;
	let generation = 0;
	let stopped = true;
	let socket: WebSocketLike | null = null;
	let cancelReconnect: (() => void) | null = null;
	let connecting = false;

	const eventListeners = new Set<(event: IncusEvent) => void>();
	const deliveryListeners = new Set<() => void>();

	function notifyDelivery(): void {
		for (const listener of [...deliveryListeners]) listener();
	}

	function clearReconnect(): void {
		if (cancelReconnect) {
			cancelReconnect();
			cancelReconnect = null;
		}
	}

	function openSocket(): void {
		if (!WebSocketCtor || stopped) return;
		if (socket !== null || connecting) return;

		connecting = true;
		const gen = generation;
		const url = browserWebSocketUrl(resolveUrl());
		const ws = new WebSocketCtor(url);
		socket = ws;

		ws.addEventListener("open", () => {
			if (gen !== generation) return;
			connecting = false;
			delivery = "live";
			reconcile = true;
			notifyDelivery();
		});

		ws.addEventListener("message", (event) => {
			if (gen !== generation) return;
			const parsed = parseIncusEvent(messageData(event));
			if (!parsed) return;
			for (const listener of [...eventListeners]) listener(parsed);
		});

		ws.addEventListener("close", () => {
			if (gen !== generation) return;
			connecting = false;
			socket = null;
			delivery = "interrupted";
			reconcile = true;
			notifyDelivery();
			if (stopped || gen !== generation) return;
			clearReconnect();
			cancelReconnect = schedule(() => {
				cancelReconnect = null;
				if (stopped || gen !== generation) return;
				openSocket();
			}, reconnectDelayMs);
		});
	}

	return {
		start() {
			if (stopped) {
				stopped = false;
			} else {
				if (delivery === "connecting" || delivery === "live") return;
				if (
					delivery === "interrupted" &&
					(connecting || socket !== null || cancelReconnect !== null)
				) {
					return;
				}
			}
			clearReconnect();
			if (socket) {
				socket.close();
				socket = null;
			}
			delivery = "connecting";
			reconcile = false;
			notifyDelivery();
			openSocket();
		},

		stop() {
			stopped = true;
			generation += 1;
			clearReconnect();
			connecting = false;
			if (socket) {
				socket.close();
				socket = null;
			}
			delivery = "closed";
			notifyDelivery();
		},

		delivery() {
			return delivery;
		},

		needsReconcile() {
			return reconcile;
		},

		noteReconciled() {
			if (delivery === "live") reconcile = false;
		},

		subscribe(listener: (event: IncusEvent) => void) {
			eventListeners.add(listener);
			return () => {
				eventListeners.delete(listener);
			};
		},

		subscribeDelivery(listener: () => void) {
			deliveryListeners.add(listener);
			return () => {
				deliveryListeners.delete(listener);
			};
		},
	};
}
