// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { type PersistedInstance, recordsFromAdapterResult } from "./persist.ts";

export type TabMessage =
	| { kind: "logout"; from: string; sessionGeneration: number }
	| {
			kind: "instances";
			from: string;
			sessionGeneration: number;
			deploymentId: string;
			records: PersistedInstance[];
	  };

export type TabBridgeOptions = {
	tabId?: string;
	sessionGeneration: () => number;
	onLogout: () => void;
	onInstances: (records: PersistedInstance[]) => void;
	post?: (message: TabMessage) => void;
	channelName?: string;
};

export type TabBridge = {
	tabId: string;
	publishLogout(): void;
	publishInstances(records: PersistedInstance[]): void;
	handle(message: TabMessage): void;
	close(): void;
};

const DEFAULT_CHANNEL = "incus-ui";

export function createTabBridge(options: TabBridgeOptions): TabBridge {
	const tabId = options.tabId ?? createTabId();
	const { sessionGeneration, onLogout, onInstances, post } = options;
	let channel: BroadcastChannel | undefined;
	if (!post && typeof globalThis.BroadcastChannel === "function") {
		channel = new BroadcastChannel(options.channelName ?? DEFAULT_CHANNEL);
		channel.onmessage = (event: MessageEvent) => {
			handle(event.data as TabMessage);
		};
	}

	function send(message: TabMessage): void {
		if (post) {
			post(message);
			return;
		}
		channel?.postMessage(message);
	}

	function publishLogout(): void {
		send({
			kind: "logout",
			from: tabId,
			sessionGeneration: sessionGeneration(),
		});
	}

	function publishInstances(records: PersistedInstance[]): void {
		const safe = recordsFromAdapterResult(records);
		send({
			kind: "instances",
			from: tabId,
			sessionGeneration: sessionGeneration(),
			deploymentId: safe[0]?.deploymentId ?? "",
			records: safe,
		});
	}

	function handle(message: TabMessage): void {
		if (!isForeignMessage(message)) return;
		if (message.kind === "logout") {
			onLogout();
			return;
		}
		if (message.kind !== "instances") return;
		if (message.sessionGeneration !== sessionGeneration()) return;
		if (!Array.isArray(message.records)) return;
		onInstances(recordsFromAdapterResult(message.records));
	}

	function close(): void {
		if (!channel) return;
		channel.onmessage = null;
		channel.close();
		channel = undefined;
	}

	function isForeignMessage(message: TabMessage): message is TabMessage {
		if (typeof message !== "object" || message === null) return false;
		if (typeof message.from !== "string" || message.from === tabId)
			return false;
		return message.kind === "logout" || message.kind === "instances";
	}

	return { tabId, publishLogout, publishInstances, handle, close };
}

function createTabId(): string {
	const cryptoApi = globalThis.crypto;
	if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
