// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { Toaster, toast } from "sonner";
import {
	useEventsStatus,
	useIncusEvents,
} from "@/hooks/incus/use-incus-events";
import {
	type Notice,
	noticeForLifecycle,
	noticeForOperation,
} from "@/lib/incus/notifications";
import { ALL_PROJECTS } from "@/lib/incus/project-scope";

const CONNECTION_TOAST = "events:connection";

function show(notice: Notice) {
	const options = { id: notice.id, description: notice.description };
	switch (notice.tone) {
		case "loading":
			toast.loading(notice.title, options);
			return;
		case "success":
			toast.success(notice.title, options);
			return;
		case "error":
			toast.error(notice.title, { ...options, duration: 10_000 });
			return;
		case "info":
			toast.info(notice.title, options);
			return;
	}
}

/**
 * Pop-up notifications for Incus activity across all projects: operations
 * update one toast in place from running to done; resource changes (create,
 * delete, rename, start, stop, ...) get a short toast. Uses the shared events
 * connection, so it opens no socket of its own.
 */
export function EventToasts() {
	const running = useRef(new Set<string>());

	useIncusEvents({
		scope: ALL_PROJECTS,
		types: ["lifecycle", "operation"],
		onEvent: (event) => {
			const notice =
				event.type === "operation"
					? noticeForOperation(event)
					: noticeForLifecycle(event);
			if (!notice) return;
			if (notice.tone === "loading") running.current.add(notice.id);
			else running.current.delete(notice.id);
			show(notice);
		},
		onInterrupted: () => {
			toast.warning("Live updates interrupted", {
				id: CONNECTION_TOAST,
				description: "Reconnecting to Incus…",
				duration: Number.POSITIVE_INFINITY,
			});
		},
		onRecovery: () => {
			// Incus does not replay events: a running operation may have finished
			// while we were disconnected, so its spinner can no longer be trusted.
			for (const id of running.current) {
				toast.info("Operation status unknown", {
					id,
					description: "Live updates were interrupted; check its result.",
				});
			}
			running.current.clear();
			toast.success("Live updates restored", {
				id: CONNECTION_TOAST,
				description: "Refreshing anything that changed meanwhile.",
				duration: 4_000,
			});
		},
	});

	const status = useEventsStatus(ALL_PROJECTS);
	useEffect(() => {
		if (status.state === "failed") {
			toast.error("Live updates unavailable", {
				id: CONNECTION_TOAST,
				description:
					status.lastError?.kind === "forbidden"
						? "This session is not allowed to receive events."
						: "Could not reconnect to Incus. Reload to try again.",
				duration: Number.POSITIVE_INFINITY,
			});
		}
	}, [status.state, status.lastError?.kind]);

	return (
		<Toaster
			theme="dark"
			position="bottom-right"
			richColors
			closeButton
			visibleToasts={5}
		/>
	);
}
