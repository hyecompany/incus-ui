// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import {
	LoadingStatus,
	SkeletonTableRows,
} from "@/components/loading/skeletons";
import { Button } from "@/components/ui/button";
import { useInstances } from "@/hooks/incus/use-instances";
import { collectionView } from "@/lib/incus/data/loading";
import type { InstanceStatus } from "@/lib/incus/instances";
import { cn } from "@/lib/ui/utils";

const FILTERS: Array<{ label: string; status?: InstanceStatus }> = [
	{ label: "All" },
	{ label: "Running", status: "Running" },
	{ label: "Stopped", status: "Stopped" },
	{ label: "Frozen", status: "Frozen" },
];

const DOT: Record<string, string> = {
	Running: "bg-emerald-500",
	Stopped: "bg-muted-foreground",
	Frozen: "bg-sky-400",
	Error: "bg-destructive",
};

function Flag({ on, label }: { on: boolean; label: string }) {
	return (
		<span
			className={cn(
				"rounded px-1.5 py-0.5",
				on
					? "bg-emerald-500/15 text-emerald-500"
					: "bg-muted text-muted-foreground",
			)}
		>
			{label}
		</span>
	);
}

/** Fields the list shows; shared with prefetching so both use one request. */
export const INSTANCE_LIST_FIELDS = ["status", "type", "location"] as const;

/** Instances in the current project scope, kept live by the data layer. */
export function InstanceList() {
	const [filter, setFilter] = useState<InstanceStatus | undefined>(undefined);
	const result = useInstances(INSTANCE_LIST_FIELDS, {
		status: filter,
	});
	const rows = result.data ?? [];
	const view = collectionView(result);
	const loading =
		view.kind === "skeleton" || (view.kind === "data" && view.pending > 0);

	return (
		<section className="flex flex-col gap-3 p-4 lg:p-6">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<h2 className="mr-2 text-sm font-semibold">Instances</h2>
				{FILTERS.map((f) => (
					<Button
						key={f.label}
						size="sm"
						variant={filter === f.status ? "default" : "outline"}
						onClick={() => setFilter(f.status)}
					>
						{f.label}
					</Button>
				))}
				<span className="ml-auto flex gap-1 font-mono">
					<Flag on={result.complete} label="complete" />
					<Flag on={result.fresh} label="fresh" />
					<Flag on={result.fetching} label="fetching" />
				</span>
			</div>
			{loading && <LoadingStatus label="Loading instances" />}
			{result.error && (
				<p className="rounded-lg border border-destructive/40 px-3 py-2 text-xs text-destructive">
					{result.error.kind}: {result.error.message}
				</p>
			)}
			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full text-left text-sm" aria-busy={loading}>
					<thead className="border-b text-xs text-muted-foreground">
						<tr>
							<th className="px-3 py-2 font-medium">Name</th>
							<th className="px-3 py-2 font-medium">Project</th>
							<th className="px-3 py-2 font-medium">Status</th>
							<th className="px-3 py-2 font-medium">Type</th>
							<th className="px-3 py-2 font-medium">Location</th>
						</tr>
					</thead>
					<tbody className="divide-y">
						{rows.map((row) => (
							<tr key={`${row.project}/${row.name}`}>
								<td className="px-3 py-2 font-medium">{row.name}</td>
								<td className="px-3 py-2">{row.project}</td>
								<td className="px-3 py-2">
									<span className="inline-flex items-center gap-2">
										<span
											className={cn(
												"size-2 rounded-full",
												DOT[row.status] ?? "bg-amber-500",
											)}
										/>
										{row.status}
									</span>
								</td>
								<td className="px-3 py-2">{row.type}</td>
								<td className="px-3 py-2">
									{row.location === "none" ? "—" : row.location}
								</td>
							</tr>
						))}
						{view.kind === "skeleton" && <SkeletonTableRows columns={5} />}
						{view.kind === "data" && view.pending > 0 && (
							<SkeletonTableRows
								columns={5}
								rows={Math.min(view.pending, 10)}
							/>
						)}
						{(view.kind === "empty" || view.kind === "error") && (
							<tr>
								<td
									colSpan={5}
									className="px-3 py-6 text-center text-xs text-muted-foreground"
								>
									{view.kind === "empty"
										? "No instances match."
										: "Instances could not be loaded."}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</section>
	);
}
