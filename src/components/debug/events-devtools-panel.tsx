// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import {
	IncusEventsContext,
	useActiveEventsManager,
} from "@/components/providers/events-provider";
import { Button } from "@/components/ui/button";
import {
	useEventsStatus,
	useIncusEvents,
} from "@/hooks/incus/use-incus-events";
import type { IncusEventsManager } from "@/lib/incus/events";
import {
	INCUS_EVENT_TYPES,
	type IncusEvent,
	type IncusEventType,
	type ScopeStatus,
} from "@/lib/incus/events";
import { ALL_PROJECTS } from "@/lib/incus/project-scope";
import { parseResourceChange } from "@/lib/incus/resource-events";
import { cn } from "@/lib/ui/utils";

/** Rows kept in memory. Older rows are dropped; nothing is persisted. */
const MAX_ROWS = 200;

type RowInput =
	| { kind: "event"; receivedAt: Date; event: IncusEvent }
	| { kind: "notice"; receivedAt: Date; text: string };

type Row = RowInput & { id: number };

const STATE_STYLES: Record<ScopeStatus["state"], string> = {
	idle: "bg-muted text-muted-foreground",
	connecting: "bg-amber-500/15 text-amber-500",
	connected: "bg-emerald-500/15 text-emerald-500",
	reconnecting: "bg-amber-500/15 text-amber-500",
	failed: "bg-destructive/15 text-destructive",
};

const VERB_STYLES: Record<string, string> = {
	created: "bg-emerald-500/15 text-emerald-500",
	deleted: "bg-destructive/15 text-destructive",
	updated: "bg-sky-500/15 text-sky-400",
	renamed: "bg-violet-500/15 text-violet-400",
};

const TYPE_STYLES: Record<IncusEventType, string> = {
	lifecycle: "text-sky-400",
	operation: "text-violet-400",
	logging: "text-muted-foreground",
};

function field(metadata: unknown, key: string): string | undefined {
	if (typeof metadata !== "object" || metadata === null) {
		return undefined;
	}
	const value = (metadata as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function summarize(event: IncusEvent): string {
	const m = event.metadata;
	switch (event.type) {
		case "lifecycle": {
			const change = parseResourceChange(event);
			return change
				? `${change.collection}${change.name ? `/${change.name}` : ""} (${change.path})`
				: [field(m, "action"), field(m, "source")].filter(Boolean).join(" ");
		}
		case "operation":
			return [field(m, "description"), field(m, "status")]
				.filter(Boolean)
				.join(" — ");
		case "logging":
			return `[${field(m, "level") ?? "?"}] ${field(m, "message") ?? ""}`;
	}
}

function ActionBadge({ event }: { event: IncusEvent }) {
	const change = parseResourceChange(event);
	if (!change) {
		return null;
	}
	return (
		<span
			className={cn(
				"rounded px-1.5",
				VERB_STYLES[change.verb] ?? "bg-muted text-muted-foreground",
			)}
		>
			{change.action}
		</span>
	);
}

function StatusBadge({
	label,
	status,
}: {
	label: string;
	status: ScopeStatus;
}) {
	return (
		<div className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
			<span className="font-medium">{label}</span>
			<span
				className={cn(
					"rounded px-1.5 py-0.5 font-mono",
					STATE_STYLES[status.state],
				)}
			>
				{status.state}
			</span>
			<span className="text-muted-foreground">gen {status.generation}</span>
			{status.lastError && (
				<span className="text-destructive">
					{status.lastError.kind}: {status.lastError.message}
				</span>
			)}
		</div>
	);
}

/**
 * TanStack devtools panel for Incus event connections and a bounded in-memory
 * event feed. The devtools shell renders outside the session providers, so the
 * active events manager is re-provided here.
 */
export function EventsDevtoolsPanel() {
	const manager = useActiveEventsManager();
	return (
		<IncusEventsContext.Provider value={manager}>
			<EventsFeed manager={manager} />
		</IncusEventsContext.Provider>
	);
}

function EventsFeed({ manager }: { manager: IncusEventsManager | null }) {
	const scope = ALL_PROJECTS;
	const [types, setTypes] = useState<IncusEventType[]>([...INCUS_EVENT_TYPES]);
	const [rows, setRows] = useState<Row[]>([]);
	const [paused, setPaused] = useState(false);
	const [counts, setCounts] = useState<Record<IncusEventType, number>>({
		lifecycle: 0,
		operation: 0,
		logging: 0,
	});
	const nextId = useRef(0);

	const push = (row: RowInput) => {
		const id = nextId.current++;
		setRows((current) => [{ ...row, id }, ...current].slice(0, MAX_ROWS));
	};

	useIncusEvents(
		types.length === 0
			? null
			: {
					scope,
					types,
					onEvent: (event) => {
						setCounts((c) => ({ ...c, [event.type]: c[event.type] + 1 }));
						if (!paused) {
							push({ kind: "event", receivedAt: new Date(), event });
						}
					},
					onInterrupted: (status) =>
						push({
							kind: "notice",
							receivedAt: new Date(),
							text: `⚠ ${status.stream ?? "core"} interrupted (${status.lastError?.message ?? "unknown"}). Events may be missed until recovery.`,
						}),
					onRecovery: (notice) =>
						push({
							kind: "notice",
							receivedAt: new Date(),
							text: `↻ ${notice.stream ?? "core"} reconnected (gen ${notice.generation}). Transport restored — consumers must reconcile; missed events are NOT replayed.`,
						}),
				},
	);

	const core = useEventsStatus(scope, "core");
	const logging = useEventsStatus(scope, "logging");

	const toggle = (type: IncusEventType) =>
		setTypes((current) =>
			current.includes(type)
				? current.filter((t) => t !== type)
				: [...current, type],
		);

	return (
		<div className="flex flex-col gap-3 p-2 text-sm">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span
					className={cn(
						"rounded-md px-2 py-1",
						manager
							? "bg-emerald-500/15 text-emerald-500"
							: "bg-destructive/15 text-destructive",
					)}
				>
					{manager ? "session: connected" : "session: not connected"}
				</span>
				{!manager && (
					<span className="text-muted-foreground">
						No events manager in context. Events are only visible while the UI
						session is mounted.
					</span>
				)}
			</div>

			<div className="flex flex-wrap gap-2">
				<StatusBadge label="core (lifecycle, operation)" status={core} />
				<StatusBadge label="logging" status={logging} />
			</div>

			<div className="flex flex-wrap items-center gap-3 text-xs">
				{INCUS_EVENT_TYPES.map((type) => (
					<label key={type} className="flex items-center gap-1.5">
						<input
							type="checkbox"
							checked={types.includes(type)}
							onChange={() => toggle(type)}
						/>
						<span className={TYPE_STYLES[type]}>{type}</span>
						<span className="text-muted-foreground">({counts[type]})</span>
					</label>
				))}
				<div className="ml-auto flex gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={() => setPaused((p) => !p)}
					>
						{paused ? "Resume" : "Pause"}
					</Button>
					<Button size="sm" variant="outline" onClick={() => setRows([])}>
						Clear
					</Button>
				</div>
			</div>

			<div className="overflow-hidden rounded-md border">
				{rows.length === 0 ? (
					<p className="p-3 text-xs text-muted-foreground">
						No events yet. Start/stop an instance or run e.g.{" "}
						<code>incus config set &lt;instance&gt; user.debug=1</code> to emit
						a lifecycle event.
					</p>
				) : (
					<ul className="max-h-96 divide-y overflow-y-auto font-mono text-xs">
						{rows.map((row) =>
							row.kind === "notice" ? (
								<li
									key={row.id}
									className="bg-amber-500/10 px-3 py-2 text-amber-500"
								>
									{row.receivedAt.toLocaleTimeString()} {row.text}
								</li>
							) : (
								<li key={row.id} className="px-3 py-1.5">
									<details>
										<summary className="flex cursor-pointer flex-wrap gap-x-3">
											<span className="text-muted-foreground">
												{row.receivedAt.toLocaleTimeString()}
											</span>
											<span className={TYPE_STYLES[row.event.type]}>
												{row.event.type}
											</span>
											<ActionBadge event={row.event} />
											<span>project={row.event.project ?? "—"}</span>
											<span>location={row.event.location ?? "—"}</span>
											<span className="min-w-0 flex-1 truncate">
												{summarize(row.event)}
											</span>
										</summary>
										<pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2">
											{JSON.stringify(row.event, null, 2)}
										</pre>
									</details>
								</li>
							),
						)}
					</ul>
				)}
			</div>
		</div>
	);
}
