// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { type ToastTone, toastManager } from "@/components/ui/toast";
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
/** Timeout 0 keeps a toast until it is replaced or dismissed. */
const STICKY = 0;
const DEFAULT_TIMEOUT = 4_000;
const ERROR_TIMEOUT = 10_000;

function timeoutFor(tone: ToastTone): number {
	switch (tone) {
		case "loading":
			return STICKY;
		case "error":
			return ERROR_TIMEOUT;
		default:
			return DEFAULT_TIMEOUT;
	}
}

interface ShowOptions {
	/** Same id as an existing toast updates it in place. */
	id: string;
	tone: ToastTone;
	title: string;
	description?: string;
	timeout?: number;
}

function show({ id, tone, title, description, timeout }: ShowOptions) {
	toastManager.add({
		id,
		type: tone,
		title,
		description,
		timeout: timeout ?? timeoutFor(tone),
	});
}

function showNotice(notice: Notice) {
	show({
		id: notice.id,
		tone: notice.tone,
		title: notice.title,
		description: notice.description,
	});
}

/** Toasts for operations and resource changes across all projects. Renders nothing; see `Toaster`. */
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
			showNotice(notice);
		},
		onInterrupted: () => {
			show({
				id: CONNECTION_TOAST,
				tone: "warning",
				title: "Live updates interrupted",
				description: "Reconnecting to Incus…",
				timeout: STICKY,
			});
		},
		onRecovery: () => {
			// Events are not replayed, so running operations may have finished meanwhile.
			for (const id of running.current) {
				show({
					id,
					tone: "info",
					title: "Operation status unknown",
					description: "Live updates were interrupted; check its result.",
				});
			}
			running.current.clear();
			show({
				id: CONNECTION_TOAST,
				tone: "success",
				title: "Live updates restored",
				description: "Refreshing anything that changed meanwhile.",
				timeout: 4_000,
			});
		},
	});

	const status = useEventsStatus(ALL_PROJECTS);
	useEffect(() => {
		if (status.state === "failed") {
			show({
				id: CONNECTION_TOAST,
				tone: "error",
				title: "Live updates unavailable",
				description:
					status.lastError?.kind === "forbidden"
						? "This session is not allowed to receive events."
						: "Could not reconnect to Incus. Reload to try again.",
				timeout: STICKY,
			});
		}
	}, [status.state, status.lastError?.kind]);

	return null;
}
