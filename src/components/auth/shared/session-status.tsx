// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconLoader2, IconPlugConnectedX } from "@tabler/icons-react";
import { useState } from "react";
import { useSessionStore } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import type { IncusApiError } from "@/lib/incus/client";

export function SessionLoading({ label = "Connecting to Incus…" }) {
	return (
		<output className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
			<IconLoader2 className="size-4 motion-safe:animate-spin" />
			{label}
		</output>
	);
}

/** Full-page error when GET /1.0 fails for a reason other than authentication. */
export function SessionError({ error }: { error: IncusApiError }) {
	const store = useSessionStore();
	const [retrying, setRetrying] = useState(false);
	return (
		<div className="flex min-h-svh items-center justify-center p-6">
			<div
				role="alert"
				className="flex max-w-md flex-col items-center gap-3 text-center"
			>
				<IconPlugConnectedX className="size-8 text-muted-foreground" />
				<h1 className="text-lg font-semibold">Could not reach Incus</h1>
				<p className="text-sm text-muted-foreground">
					{error.kind === "network"
						? "The server did not respond. Check that Incus is running and reachable from this browser, then try again."
						: `Incus returned an error: ${error.message}`}
				</p>
				<Button
					disabled={retrying || !store}
					onClick={async () => {
						setRetrying(true);
						await store?.refresh();
						setRetrying(false);
					}}
				>
					{retrying && <IconLoader2 className="motion-safe:animate-spin" />}
					Try again
				</Button>
			</div>
		</div>
	);
}
