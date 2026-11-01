// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import {
	type IncusEvent,
	IncusEventsManager,
	type RecoveryNotice,
	type ScopeStatus,
	type Subscription,
	type WebSocketLike,
} from "../../src/lib/incus/events/index.ts";
import {
	ALL_PROJECTS,
	type ProjectScope,
} from "../../src/lib/incus/project-scope.ts";

const DEV: ProjectScope = { kind: "project", name: "dev" };
const ORIGIN = "https://incus.test:8443";

class FakeSocket implements WebSocketLike {
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	closedWith: number[] = [];
	droppedByPeer = false;

	constructor(url: string) {
		this.url = url;
	}

	close(code?: number): void {
		this.closedWith.push(code ?? 0);
	}

	open(): void {
		this.onopen?.();
	}

	receive(data: unknown): void {
		this.onmessage?.({ data });
	}

	/** Simulates the server or network dropping the socket. */
	drop(code = 1006): void {
		this.droppedByPeer = true;
		this.onclose?.({ code });
	}
}

interface Harness {
	manager: IncusEventsManager;
	sockets: FakeSocket[];
	probeStatuses: (number | Error)[];
	probeUrls: string[];
	clock: { now: number };
	pending(): number;
	advance(ms: number): void;
}

function harness(options: { maxAttempts?: number } = {}): Harness {
	const sockets: FakeSocket[] = [];
	const probeUrls: string[] = [];
	const probeStatuses: (number | Error)[] = [];
	const clock = { now: 0 };
	let nextId = 1;
	const timers = new Map<number, { at: number; callback: () => void }>();

	const manager = new IncusEventsManager({
		origin: ORIGIN,
		createSocket(url) {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket;
		},
		fetchImpl: async (input) => {
			probeUrls.push(String(input));
			const next = probeStatuses.shift() ?? 503;
			if (next instanceof Error) {
				throw next;
			}
			return new Response(null, { status: next });
		},
		now: () => clock.now,
		setTimeout: (callback, ms) => {
			const id = nextId++;
			timers.set(id, { at: clock.now + ms, callback });
			return id;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		random: () => 0.5,
		maxAttempts: options.maxAttempts,
	});

	return {
		manager,
		sockets,
		probeStatuses,
		probeUrls,
		clock,
		pending: () => timers.size,
		advance(ms) {
			const target = clock.now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= target)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) {
					break;
				}
				timers.delete(due[0]);
				clock.now = due[1].at;
				due[1].callback();
			}
			clock.now = target;
		},
	};
}

/** Lets pending promise continuations (the HTTP probe) run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/** The most recent socket for one stream, found by its type param. */
function streamSocket(h: Harness, type: string): FakeSocket {
	const matches = h.sockets.filter(
		(s) => new URL(s.url).searchParams.get("type") === type,
	);
	const socket = matches.at(-1);
	assert.ok(socket, `no socket for type ${type}`);
	return socket;
}

function lifecycle(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "lifecycle",
		timestamp: "2026-11-01T10:00:00Z",
		metadata: { action: "instance-created" },
		...extra,
	});
}

/** Core-stream subscriber by default; pass types explicitly for logging. */
function recorder(
	scope: ProjectScope,
	types: Subscription["types"] = ["lifecycle", "operation"],
) {
	const events: IncusEvent[] = [];
	const recoveries: RecoveryNotice[] = [];
	const interruptions: ScopeStatus[] = [];
	const subscription: Subscription = {
		scope,
		types,
		onEvent: (event) => events.push(event),
		onRecovery: (notice) => recoveries.push(notice),
		onInterrupted: (status) => interruptions.push(status),
	};
	return { subscription, events, recoveries, interruptions };
}

describe("connection", () => {
	it("opens one socket to /1.0/events and reports connecting then connected", () => {
		const h = harness();
		const seen: string[] = [];
		h.manager.onStatus((s) => seen.push(s.state));
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);

		assert.equal(h.sockets.length, 1);
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "connecting");

		h.sockets[0].open();
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "connected");
		assert.deepEqual(seen, ["connecting", "connected"]);
	});

	it("shares one socket between subscribers of the same scope", () => {
		const h = harness();
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		h.manager.subscribe(recorder(ALL_PROJECTS, ["lifecycle"]).subscription);
		assert.equal(h.sockets.length, 1);
	});

	it("uses one socket per scope key", () => {
		const h = harness();
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		h.manager.subscribe(recorder(DEV).subscription);
		assert.equal(h.sockets.length, 2);
	});
});

describe("URL construction", () => {
	it("requests core types and all-projects in All Projects mode", () => {
		const h = harness();
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		const url = new URL(h.sockets[0].url);
		assert.equal(url.protocol, "wss:");
		assert.equal(url.host, "incus.test:8443");
		assert.equal(url.pathname, "/1.0/events");
		assert.equal(url.searchParams.get("type"), "lifecycle,operation");
		assert.equal(url.searchParams.get("all-projects"), "true");
		assert.equal(url.searchParams.has("project"), false);
	});

	it("opens a separate logging socket that requests only logging", () => {
		const h = harness();
		h.manager.subscribe(
			recorder(ALL_PROJECTS, ["lifecycle", "operation", "logging"]).subscription,
		);
		assert.equal(h.sockets.length, 2);
		const logging = new URL(streamSocket(h, "logging").url);
		assert.equal(logging.searchParams.get("type"), "logging");
		assert.equal(logging.searchParams.get("all-projects"), "true");
	});

	it("uses project= for a specific project and never all-projects", () => {
		const h = harness();
		h.manager.subscribe(recorder(DEV).subscription);
		const url = new URL(h.sockets[0].url);
		assert.equal(url.searchParams.get("project"), "dev");
		assert.equal(url.searchParams.has("all-projects"), false);
	});

	it("maps http origins to ws", () => {
		const sockets: string[] = [];
		const manager = new IncusEventsManager({
			origin: "http://127.0.0.1:3001",
			createSocket(url) {
				sockets.push(url);
				return new FakeSocket(url);
			},
		});
		manager.subscribe(recorder(ALL_PROJECTS).subscription);
		assert.ok(sockets[0].startsWith("ws://127.0.0.1:3001/1.0/events?"));
		manager.dispose();
	});
});

describe("dispatch", () => {
	it("filters by subscriber type and keeps arrival order across streams", () => {
		const h = harness();
		const lifecycleOnly = recorder(ALL_PROJECTS, ["lifecycle"]);
		const everything = recorder(ALL_PROJECTS, ["lifecycle", "operation", "logging"]);
		h.manager.subscribe(lifecycleOnly.subscription);
		h.manager.subscribe(everything.subscription);
		const core = streamSocket(h, "lifecycle,operation");
		const logging = streamSocket(h, "logging");
		core.open();
		logging.open();

		core.receive(lifecycle({ timestamp: "t1" }));
		logging.receive(
			JSON.stringify({ type: "logging", timestamp: "t2", metadata: { message: "m" } }),
		);
		core.receive(lifecycle({ timestamp: "t3" }));

		assert.deepEqual(
			lifecycleOnly.events.map((e) => e.timestamp),
			["t1", "t3"],
		);
		assert.deepEqual(
			everything.events.map((e) => e.timestamp),
			["t1", "t2", "t3"],
		);
	});

	it("preserves project and location context and does not guess it", () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.sockets[0].open();

		h.sockets[0].receive(lifecycle({ project: "dev", location: "node-2" }));
		h.sockets[0].receive(
			lifecycle({ metadata: { action: "x", source: "/1.0/instances/a?project=other" } }),
		);

		assert.equal(sub.events[0].project, "dev");
		assert.equal(sub.events[0].location, "node-2");
		assert.equal("project" in sub.events[1], false);
		assert.equal("location" in sub.events[1], false);
	});

	it("drops invalid frames with a warning that does not include the payload", () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.sockets[0].open();
		const warn = mock.method(console, "warn", () => undefined);

		try {
			h.sockets[0].receive("{\"type\":\"lifecycle\",\"secret\":\"hunter2\"");
			h.sockets[0].receive(lifecycle({ type: "nope" }));

			assert.equal(sub.events.length, 0);
			assert.equal(warn.mock.callCount(), 2);
			for (const call of warn.mock.calls) {
				assert.equal(String(call.arguments[0]).includes("hunter2"), false);
			}
		} finally {
			warn.mock.restore();
		}
	});

	it("keeps delivering to other listeners when one throws", () => {
		const h = harness();
		const other = recorder(ALL_PROJECTS);
		h.manager.subscribe({
			scope: ALL_PROJECTS,
			types: ["lifecycle"],
			onEvent: () => {
				throw new Error("boom");
			},
		});
		h.manager.subscribe(other.subscription);
		h.sockets[0].open();
		const warn = mock.method(console, "warn", () => undefined);

		try {
			h.sockets[0].receive(lifecycle());
			assert.equal(other.events.length, 1);
			assert.equal(warn.mock.callCount(), 1);
		} finally {
			warn.mock.restore();
		}
	});

	it("delivers a duplicate subscription object once per event", () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		const unsubscribeFirst = h.manager.subscribe(sub.subscription);
		const unsubscribeSecond = h.manager.subscribe(sub.subscription);
		h.sockets[0].open();

		h.sockets[0].receive(lifecycle());
		assert.equal(sub.events.length, 1);

		unsubscribeFirst();
		assert.equal(h.sockets[0].closedWith.length, 0, "one reference still holds the socket");
		unsubscribeSecond();
		assert.deepEqual(h.sockets[0].closedWith, [1000]);
	});
});

describe("restricted permissions", () => {
	it("treats an HTTP 403 probe as forbidden and does not retry", async () => {
		const h = harness();
		h.probeStatuses.push(403);
		const seen: ScopeStatus[] = [];
		h.manager.onStatus((s) => seen.push(s));
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);

		h.sockets[0].drop();
		await flush();

		const status = h.manager.getStatus(ALL_PROJECTS);
		assert.equal(status.state, "failed");
		assert.equal(status.lastError?.kind, "forbidden");
		assert.equal(h.probeUrls.length, 1);
		assert.equal(h.probeUrls[0].startsWith("/1.0/events?"), true);

		h.advance(10 * 60_000);
		assert.equal(h.sockets.length, 1, "no retry loop after forbidden");
		assert.equal(h.pending(), 0);
	});

	it("treats HTTP 401 the same as 403", async () => {
		const h = harness();
		h.probeStatuses.push(401);
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		h.sockets[0].drop();
		await flush();
		assert.equal(h.manager.getStatus(ALL_PROJECTS).lastError?.kind, "forbidden");
	});
});

describe("reconnect and backoff", () => {
	it("reports interruption, retries with backoff, and restores the connection", async () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.sockets[0].open();

		h.sockets[0].drop();
		assert.equal(sub.interruptions.length, 1);
		assert.equal(sub.interruptions[0].state, "reconnecting");
		assert.equal(typeof sub.interruptions[0].interruptedAt, "number");
		await flush();
		assert.equal(h.sockets.length, 1, "retry waits for the backoff timer");

		h.advance(499);
		assert.equal(h.sockets.length, 1);
		h.advance(1);
		assert.equal(h.sockets.length, 2, "first retry after 500ms with random=0.5");

		h.sockets[1].open();
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "connected");
	});

	it("backs off exponentially across failed reconnect attempts", async () => {
		const h = harness();
		h.probeStatuses.push(503, 503, 503);
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);

		h.sockets[0].drop();
		await flush();
		h.advance(500);
		assert.equal(h.sockets.length, 2);
		h.sockets[1].drop();
		await flush();
		h.advance(999);
		assert.equal(h.sockets.length, 2);
		h.advance(1);
		assert.equal(h.sockets.length, 3, "second retry waits 1000ms");
	});

	it("keeps a single pending retry per scope", async () => {
		const h = harness();
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		h.sockets[0].drop();
		await flush();
		assert.equal(h.pending(), 1);
	});

	it("goes to failed after maxAttempts consecutive failures", async () => {
		const h = harness({ maxAttempts: 3 });
		h.probeStatuses.push(503, 503, 503);
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		h.sockets[0].drop();
		await flush();
		h.advance(500);
		h.sockets[1].drop();
		await flush();
		h.advance(1000);
		h.sockets[2].drop();
		await flush();

		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "failed");
		assert.equal(h.pending(), 0);
		h.advance(60_000);
		assert.equal(h.sockets.length, 3);
	});

	it("retries after a network error on the probe", async () => {
		const h = harness();
		h.probeStatuses.push(new TypeError("network down"));
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		h.sockets[0].drop();
		await flush();
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "reconnecting");
		assert.equal(h.manager.getStatus(ALL_PROJECTS).lastError?.kind, "network");
	});

	it("a new subscriber restarts a failed scope with a fresh attempt budget", async () => {
		const h = harness({ maxAttempts: 1 });
		h.probeStatuses.push(503);
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		h.sockets[0].drop();
		await flush();
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "failed");

		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		assert.equal(h.sockets.length, 2);
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "connecting");
	});
});

describe("recovery", () => {
	it("emits a RecoveryNotice with the new generation after a reconnect", async () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.sockets[0].open();
		assert.equal(h.manager.getStatus(ALL_PROJECTS).generation, 0);

		h.sockets[0].drop();
		h.advance(500);
		h.sockets[1].open();

		assert.equal(sub.recoveries.length, 1);
		assert.deepEqual(sub.recoveries[0], {
			scope: ALL_PROJECTS,
			stream: "core",
			generation: 1,
			reason: "reconnected",
		});
		const status = h.manager.getStatus(ALL_PROJECTS);
		assert.equal(status.state, "connected");
		assert.equal(status.generation, 1);
		assert.equal(status.interruptedAt, undefined);
		assert.equal(status.lastError, undefined);
	});

	it("does not emit a RecoveryNotice for the first connection", () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.sockets[0].open();
		assert.equal(sub.recoveries.length, 0);
	});

	it("does not treat a failed initial connection as an interruption", async () => {
		const h = harness();
		h.probeStatuses.push(403);
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.sockets[0].drop();
		await flush();
		assert.equal(sub.interruptions.length, 0);
		assert.equal(sub.recoveries.length, 0);
	});

	it("keeps the restored state separate from catching up", async () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.sockets[0].open();
		h.sockets[0].drop();
		h.advance(500);
		h.sockets[1].open();

		// The notice carries only the transport facts. It has no "caught up" flag.
		assert.deepEqual(Object.keys(sub.recoveries[0]).sort(), [
			"generation",
			"reason",
			"scope",
			"stream",
		]);
		assert.equal(sub.recoveries[0].reason, "reconnected");
	});
});

describe("unsubscribe and churn", () => {
	it("closes the socket with 1000 when the last subscriber leaves", () => {
		const h = harness();
		const unsubscribe = h.manager.subscribe(recorder(DEV).subscription);
		h.sockets[0].open();
		unsubscribe();
		assert.deepEqual(h.sockets[0].closedWith, [1000]);
		assert.equal(h.manager.getStatus(DEV).state, "idle");
	});

	it("keeps the socket open while other subscribers of the scope remain", () => {
		const h = harness();
		const first = h.manager.subscribe(recorder(DEV).subscription);
		h.manager.subscribe(recorder(DEV).subscription);
		first();
		assert.equal(h.sockets[0].closedWith.length, 0);
		assert.equal(h.manager.getStatus(DEV).state, "connecting");
	});

	it("leaves other scopes untouched when the header scope changes", () => {
		const h = harness();
		h.manager.subscribe(recorder(ALL_PROJECTS).subscription);
		const unsubscribeDev = h.manager.subscribe(recorder(DEV).subscription);
		h.sockets[0].open();
		unsubscribeDev();
		assert.equal(h.sockets[0].closedWith.length, 0, "ALL_PROJECTS socket stays up");
		assert.equal(h.sockets[1].closedWith[0], 1000);
	});

	it("ignores a late unsubscribe call", () => {
		const h = harness();
		const unsubscribe = h.manager.subscribe(recorder(DEV).subscription);
		unsubscribe();
		unsubscribe();
		assert.deepEqual(h.sockets[0].closedWith, [1000]);
	});

	it("leaves no sockets or timers after rapid subscribe/unsubscribe churn", async () => {
		const h = harness();
		for (let i = 0; i < 50; i++) {
			const scope: ProjectScope = i % 2 === 0 ? ALL_PROJECTS : DEV;
			const unsubscribe = h.manager.subscribe(recorder(scope).subscription);
			if (i % 3 === 0) {
				h.sockets[h.sockets.length - 1].drop();
				await flush();
			}
			unsubscribe();
		}

		for (const socket of h.sockets) {
			// A socket the peer already dropped needs no close. Every other one
			// must have been closed exactly once with 1000.
			if (!socket.droppedByPeer) {
				assert.deepEqual(socket.closedWith, [1000], "socket left open");
			}
		}
		assert.equal(h.pending(), 0);
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "idle");
		assert.equal(h.manager.getStatus(DEV).state, "idle");
	});

	it("drops late callbacks from a socket that was already closed", () => {
		const h = harness();
		const sub = recorder(DEV);
		const unsubscribe = h.manager.subscribe(sub.subscription);
		const old = h.sockets[0];
		old.open();
		unsubscribe();
		old.receive(lifecycle());
		old.open();
		assert.equal(sub.events.length, 0);
		assert.equal(h.manager.getStatus(DEV).state, "idle");
	});
});

describe("dispose", () => {
	it("closes every socket with 1000, cancels timers, and clears subscribers", async () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.manager.subscribe(recorder(DEV).subscription);
		h.sockets[0].open();
		h.sockets[1].open();
		h.sockets[0].drop();
		assert.equal(h.pending(), 1);

		h.manager.dispose();

		assert.deepEqual(h.sockets[1].closedWith, [1000]);
		assert.equal(h.pending(), 0);
		h.advance(60_000);
		assert.equal(h.sockets.length, 2, "no reconnect after dispose");
	});

	it("ignores late messages from sockets that were open at dispose", () => {
		const h = harness();
		const sub = recorder(ALL_PROJECTS);
		h.manager.subscribe(sub.subscription);
		h.sockets[0].open();
		h.manager.dispose();
		h.sockets[0].receive(lifecycle());
		h.sockets[0].drop();
		assert.equal(sub.events.length, 0);
		assert.equal(sub.interruptions.length, 0);
	});

	it("throws on subscribe after dispose", () => {
		const h = harness();
		h.manager.dispose();
		assert.throws(() => h.manager.subscribe(recorder(ALL_PROJECTS).subscription));
	});

	it("is idempotent", () => {
		const h = harness();
		h.manager.subscribe(recorder(DEV).subscription);
		h.manager.dispose();
		h.manager.dispose();
		assert.deepEqual(h.sockets[0].closedWith, [1000]);
	});

	it("does not write any status to listeners after dispose", () => {
		const h = harness();
		const seen: string[] = [];
		h.manager.onStatus((s) => seen.push(s.state));
		h.manager.subscribe(recorder(DEV).subscription);
		h.manager.dispose();
		h.sockets[0].open();
		assert.deepEqual(seen, ["connecting"]);
	});
});

describe("streams", () => {
	it("a forbidden logging stream leaves core connected and delivering", async () => {
		const h = harness();
		h.probeStatuses.push(403);
		const core = recorder(ALL_PROJECTS);
		const logs = recorder(ALL_PROJECTS, ["logging"]);
		h.manager.subscribe(core.subscription);
		h.manager.subscribe(logs.subscription);
		streamSocket(h, "lifecycle,operation").open();
		streamSocket(h, "logging").drop();
		await flush();

		assert.equal(h.manager.getStatus(ALL_PROJECTS, "logging").state, "failed");
		assert.equal(h.manager.getStatus(ALL_PROJECTS, "logging").lastError?.kind, "forbidden");
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "connected");
		assert.equal(h.manager.getStatus(ALL_PROJECTS).lastError, undefined);

		streamSocket(h, "lifecycle,operation").receive(lifecycle());
		assert.equal(core.events.length, 1, "core keeps delivering");
		assert.equal(logs.events.length, 0);
	});

	it("a subscriber spanning both streams is released from both on unsubscribe", () => {
		const h = harness();
		const unsubscribe = h.manager.subscribe(
			recorder(DEV, ["lifecycle", "logging"]).subscription,
		);
		assert.equal(h.sockets.length, 2);
		unsubscribe();
		assert.equal(streamSocket(h, "lifecycle,operation").closedWith[0], 1000);
		assert.equal(streamSocket(h, "logging").closedWith[0], 1000);
		assert.equal(h.manager.getStatus(DEV).state, "idle");
		assert.equal(h.manager.getStatus(DEV, "logging").state, "idle");
	});

	it("a core-only subscriber never opens the logging socket", () => {
		const h = harness();
		h.manager.subscribe(recorder(ALL_PROJECTS, ["operation"]).subscription);
		assert.equal(h.sockets.length, 1);
		assert.equal(
			new URL(h.sockets[0].url).searchParams.get("type"),
			"lifecycle,operation",
		);
	});

	it("reports the stream on status and defaults to core", () => {
		const h = harness();
		h.manager.subscribe(recorder(ALL_PROJECTS, ["logging"]).subscription);
		assert.equal(h.manager.getStatus(ALL_PROJECTS, "logging").stream, "logging");
		assert.equal(h.manager.getStatus(ALL_PROJECTS).stream, "core");
		assert.equal(h.manager.getStatus(ALL_PROJECTS).state, "idle");
	});

	it("keeps a logging socket's recovery separate from core", async () => {
		const h = harness();
		const logs = recorder(ALL_PROJECTS, ["logging"]);
		h.manager.subscribe(logs.subscription);
		streamSocket(h, "logging").open();
		streamSocket(h, "logging").drop();
		h.advance(500);
		streamSocket(h, "logging").open();
		assert.equal(logs.recoveries.length, 1);
		assert.equal(logs.recoveries[0].stream, "logging");
	});
});

describe("storage", () => {
	it("never touches localStorage or sessionStorage from events code", () => {
		const dir = new URL("../../src/lib/incus/events/", import.meta.url);
		const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
		files.push("../session.ts");
		for (const name of files) {
			const path = new URL(name, dir);
			const source = readFileSync(path, "utf8");
			assert.equal(/localStorage|sessionStorage/.test(source), false, name);
		}
	});
});
