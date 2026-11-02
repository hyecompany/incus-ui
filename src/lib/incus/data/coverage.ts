// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { ScopeStatus, Subscription } from "../events/types.ts";
import { ALL_PROJECTS, isSameScope } from "../project-scope.ts";
import type { CoverageState, DataCore } from "./core.ts";

/** The parts of IncusEventsManager the data layer uses. */
export interface EventSource {
	subscribe(subscription: Subscription): () => void;
	getStatus(
		scope: typeof ALL_PROJECTS,
		stream?: "core" | "logging",
	): ScopeStatus;
	onStatus(callback: (status: ScopeStatus) => void): () => void;
}

/** Maps the Events Layer's connection state to data-layer coverage. */
export function coverageFor(
	status: ScopeStatus["state"],
	previous: CoverageState,
): CoverageState {
	switch (status) {
		case "connected":
			return "connected";
		case "reconnecting":
			// Only a loss of established coverage is an interruption.
			return previous === "unavailable" ? "unavailable" : "interrupted";
		case "connecting":
			return previous === "connected" ? "interrupted" : previous;
		default:
			return "unavailable";
	}
}

/** Feeds lifecycle events into the core and tracks event coverage. */
export function connectEvents(core: DataCore, events: EventSource): () => void {
	const apply = (status: ScopeStatus) => {
		if (!isSameScope(status.scope, ALL_PROJECTS)) return;
		if ((status.stream ?? "core") !== "core") return;
		core.setCoverage(coverageFor(status.state, core.coverage.state));
	};
	const unsubscribe = events.subscribe({
		scope: ALL_PROJECTS,
		types: ["lifecycle", "operation"],
		onEvent: (event) => core.ingest(event),
	});
	const stopStatus = events.onStatus(apply);
	apply(events.getStatus(ALL_PROJECTS, "core"));
	return () => {
		stopStatus();
		unsubscribe();
		core.setCoverage("unavailable");
	};
}
