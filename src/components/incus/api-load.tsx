// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { IconRefresh } from "@tabler/icons-react";
import {
	type JSX,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useInstances } from "@/hooks/incus/use-instances";
import type { InstanceField } from "@/lib/incus/instances";
import { incusStore } from "@/lib/incus/store";
import {
	apiTimingsVersion,
	latestApiSample,
	subscribeApiTimings,
} from "@/lib/incus/timings";

const INSTANCE_FIELDS = [
	"name",
	"status",
	"project",
] as const satisfies readonly InstanceField[];

function formatMs(ms: number): string {
	if (ms < 100) return `${ms.toFixed(1)} ms`;
	return `${Math.round(ms)} ms`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

function Stat(props: {
	label: string;
	value: string | undefined;
}): JSX.Element {
	return (
		<div className="flex min-w-28 flex-col gap-1">
			<p className="text-sm text-muted-foreground">{props.label}</p>
			{props.value === undefined ? (
				<Skeleton className="h-8 w-24" />
			) : (
				<p className="text-2xl font-semibold tabular-nums">{props.value}</p>
			)}
		</div>
	);
}

export function ApiLoad(): JSX.Element {
	const instances = useInstances(INSTANCE_FIELDS);
	const timingsVersion = useSyncExternalStore(
		subscribeApiTimings,
		apiTimingsVersion,
		apiTimingsVersion,
	);
	const sample =
		timingsVersion < 0 ? undefined : latestApiSample("/1.0/instances");
	const mountStarted = useRef(performance.now());
	const fetchingStarted = useRef<number | null>(null);
	const armed = useRef(false);
	const [floorId, setFloorId] = useState(0);
	const [screenMs, setScreenMs] = useState<number | null>(null);
	const failed = instances.error !== null;

	useEffect(() => {
		if (armed.current) {
			if (!instances.fetching) return;
			armed.current = false;
			fetchingStarted.current = performance.now();
			return;
		}
		if (instances.fetching) {
			if (fetchingStarted.current === null) {
				fetchingStarted.current = performance.now();
			}
			return;
		}
		if (!instances.available && !failed) return;
		const origin = fetchingStarted.current ?? mountStarted.current;
		setScreenMs(performance.now() - origin);
		fetchingStarted.current = null;
	}, [instances.fetching, instances.available, failed]);

	const measured = sample && sample.id > floorId ? sample : undefined;

	function measureAgain(): void {
		setFloorId(latestApiSample("/1.0/instances")?.id ?? 0);
		armed.current = true;
		fetchingStarted.current = null;
		setScreenMs(null);
		incusStore.invalidateAll();
	}

	const rows = instances.data ?? [];

	return (
		<div className="flex flex-col gap-4 p-4 lg:p-6">
			<Card>
				<CardHeader>
					<CardTitle>API load</CardTitle>
					<CardDescription>
						How long this page takes to read instances from Incus.
					</CardDescription>
					<CardAction>
						<Button
							variant="outline"
							size="sm"
							disabled={instances.fetching}
							onClick={measureAgain}
						>
							<IconRefresh data-icon="inline-start" />
							Measure again
						</Button>
					</CardAction>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-wrap gap-8">
						<Stat
							label="API request"
							value={
								measured
									? formatMs(measured.durationMs)
									: screenMs === null
										? undefined
										: "Cached"
							}
						/>
						<Stat
							label="On screen"
							value={screenMs === null ? undefined : formatMs(screenMs)}
						/>
						<Stat
							label="Instances"
							value={screenMs === null ? undefined : String(rows.length)}
						/>
					</div>
					{measured ? (
						<p className="truncate text-sm text-muted-foreground">
							{measured.status} · {formatBytes(measured.bytes)} ·{" "}
							{measured.path}
						</p>
					) : null}
					{instances.error ? (
						<p className="text-sm text-destructive">
							{instances.error.message}
						</p>
					) : null}
					{rows.length > 0 ? (
						<>
							<Separator />
							<ul className="flex flex-col gap-1">
								{rows.map((instance) => (
									<li key={`${instance.project}\0${instance.name}`}>
										{instance.project
											? `${instance.project} / ${instance.name}`
											: instance.name}
										{instance.status ? ` · ${instance.status}` : ""}
									</li>
								))}
							</ul>
						</>
					) : null}
				</CardContent>
			</Card>
		</div>
	);
}
