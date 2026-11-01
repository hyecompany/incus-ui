// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { WebSocketLike } from "./manager.ts";

export {
	type BackoffOptions,
	backoffDelay,
	DEFAULT_BACKOFF,
} from "./backoff.ts";
export {
	buildEventsPath,
	channelKey,
	DEFAULT_MAX_ATTEMPTS,
	EVENTS_PATH,
	IncusEventsManager,
	type IncusEventsManagerDeps,
	streamsFor,
	toWebSocketUrl,
	type WebSocketLike,
} from "./manager.ts";
export { type ParseResult, parseEventFrame } from "./parse.ts";
export * from "./types.ts";

/** Real browser socket adapted to WebSocketLike. Only called from the provider. */
export function createBrowserSocket(url: string): WebSocketLike {
	const socket = new WebSocket(url);
	const like: WebSocketLike = {
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
		close(code, reason) {
			socket.close(code, reason);
		},
	};
	socket.onopen = () => like.onopen?.();
	socket.onmessage = (event) => like.onmessage?.({ data: event.data });
	socket.onclose = (event) => like.onclose?.({ code: event.code });
	socket.onerror = (event) => like.onerror?.(event);
	return like;
}
