// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createEventStream,
	defaultIncusEventsUrl,
	parseIncusEvent,
	type WebSocketLike,
} from "../../src/lib/incus/event-stream.ts";

type Listener = (event: unknown) => void;

class FakeWebSocket implements WebSocketLike {
	static latest: FakeWebSocket | null = null;
	readonly url: string;
	private listeners = new Map<string, Set<Listener>>();

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.latest = this;
	}

	addEventListener(
		type: "open" | "message" | "close",
		listener: Listener,
	): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	close(): void {
		this.emit("close", {});
	}

	emit(type: "open" | "message" | "close", event: unknown): void {
		const set = this.listeners.get(type);
		if (!set) return;
		for (const listener of [...set]) listener(event);
	}

	send(data: string): void {
		this.emit("message", { data });
	}
}

function createHarness(options?: {
	reconnectDelayMs?: number;
	schedule?: (callback: () => void, delayMs: number) => () => void;
}) {
	const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
	const schedule =
		options?.schedule ??
		((callback: () => void, delayMs: number) => {
			scheduled.push({ callback, delayMs });
			return () => {
				const index = scheduled.findIndex(
					(entry) => entry.callback === callback,
				);
				if (index >= 0) scheduled.splice(index, 1);
			};
		});

	const stream = createEventStream({
		webSocket: FakeWebSocket,
		reconnectDelayMs: options?.reconnectDelayMs ?? 50,
		schedule,
	});

	return {
		stream,
		scheduled,
		socket(): FakeWebSocket {
			assert.ok(FakeWebSocket.latest);
			return FakeWebSocket.latest;
		},
	};
}

describe("parseIncusEvent", () => {
	it("default url contains lifecycle,operation,logging and all-projects without project=", () => {
		const path = defaultIncusEventsUrl();
		assert.match(path, /type=lifecycle,operation,logging/);
		assert.match(path, /all-projects=true/);
		assert.doesNotMatch(path, /project=/);

		const harness = createHarness();
		harness.stream.start();
		assert.equal(harness.socket().url, path);
	});

	it("reads lifecycle project from source and keeps location", () => {
		const parsed = parseIncusEvent(
			JSON.stringify({
				type: "lifecycle",
				timestamp: "2026-01-01T00:00:00Z",
				location: "node-1",
				metadata: {
					action: "instance-created",
					source: "/1.0/instances/web-1?project=production",
				},
			}),
		);
		assert.deepEqual(parsed, {
			type: "lifecycle",
			timestamp: "2026-01-01T00:00:00Z",
			location: "node-1",
			project: "production",
			metadata: {
				action: "instance-created",
				source: "/1.0/instances/web-1?project=production",
			},
		});

		const missingProject = parseIncusEvent(
			JSON.stringify({
				type: "lifecycle",
				timestamp: "2026-01-01T00:00:00Z",
				metadata: {
					source: "/1.0/instances/web-1",
				},
			}),
		);
		assert.equal(missingProject?.project, "default");

		const nonInstance = parseIncusEvent(
			JSON.stringify({
				type: "lifecycle",
				timestamp: "2026-01-01T00:00:00Z",
				metadata: {
					source: "/1.0/networks/bridge0?project=staging",
				},
			}),
		);
		assert.equal(nonInstance?.project, "staging");
	});

	it("keeps operation metadata.project and logging context.project", () => {
		const operation = parseIncusEvent(
			JSON.stringify({
				type: "operation",
				timestamp: "2026-01-01T00:00:00Z",
				location: "node-2",
				metadata: { project: "ops", id: "abc" },
			}),
		);
		assert.equal(operation?.project, "ops");

		const logging = parseIncusEvent(
			JSON.stringify({
				type: "logging",
				timestamp: "2026-01-01T00:00:00Z",
				metadata: { context: { project: "logs" }, message: "hello" },
			}),
		);
		assert.equal(logging?.project, "logs");
	});

	it("ignores non-json and unknown type", () => {
		assert.equal(parseIncusEvent("not-json"), null);
		assert.equal(
			parseIncusEvent(JSON.stringify({ type: "config", timestamp: "t" })),
			null,
		);
	});
});

describe("createEventStream", () => {
	it("reconnects after close and keeps needsReconcile until noteReconciled", () => {
		const harness = createHarness({ reconnectDelayMs: 10 });
		const { stream, scheduled } = harness;

		stream.start();
		const first = harness.socket();
		first.emit("open", {});
		assert.equal(stream.delivery(), "live");
		assert.equal(stream.needsReconcile(), true);
		stream.noteReconciled();
		assert.equal(stream.needsReconcile(), false);

		first.emit("close", {});
		assert.equal(stream.delivery(), "interrupted");
		assert.equal(stream.needsReconcile(), true);
		assert.equal(scheduled.length, 1);
		assert.equal(scheduled[0]?.delayMs, 10);

		scheduled[0]?.callback();
		const second = harness.socket();
		assert.notEqual(first, second);
		second.emit("open", {});
		assert.equal(stream.delivery(), "live");
		assert.equal(stream.needsReconcile(), true);
		stream.noteReconciled();
		assert.equal(stream.needsReconcile(), false);
	});

	it("stop prevents reconnect and ignores a late message", () => {
		const harness = createHarness({ reconnectDelayMs: 10 });
		const { stream, scheduled } = harness;
		const received: string[] = [];
		stream.subscribe((event) => {
			received.push(event.project);
		});

		stream.start();
		const socket = harness.socket();
		socket.emit("open", {});
		stream.stop();
		assert.equal(stream.delivery(), "closed");
		assert.equal(scheduled.length, 0);

		socket.send(
			JSON.stringify({
				type: "operation",
				timestamp: "2026-01-01T00:00:00Z",
				metadata: { project: "late" },
			}),
		);
		assert.deepEqual(received, []);

		socket.emit("close", {});
		assert.equal(scheduled.length, 0);
		assert.equal(stream.delivery(), "closed");
	});

	it("delivers one frame to two subscribers until one unsubscribes", () => {
		const harness = createHarness();
		const { stream } = harness;
		const a: string[] = [];
		const b: string[] = [];
		const offA = stream.subscribe((event) => {
			a.push(event.project);
		});
		const offB = stream.subscribe((event) => {
			b.push(event.project);
		});

		stream.start();
		const socket = harness.socket();
		socket.emit("open", {});
		socket.send(
			JSON.stringify({
				type: "logging",
				timestamp: "2026-01-01T00:00:00Z",
				metadata: { context: { project: "shared" } },
			}),
		);
		assert.deepEqual(a, ["shared"]);
		assert.deepEqual(b, ["shared"]);

		offA();
		socket.send(
			JSON.stringify({
				type: "logging",
				timestamp: "2026-01-01T00:00:00Z",
				metadata: { context: { project: "solo" } },
			}),
		);
		assert.deepEqual(a, ["shared"]);
		assert.deepEqual(b, ["shared", "solo"]);
		offB();
	});
});
