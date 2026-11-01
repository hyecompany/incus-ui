// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useIncusSession } from "@/components/providers/session-provider";
import { createBrowserSocket, IncusEventsManager } from "@/lib/incus/events";

export const IncusEventsContext = createContext<IncusEventsManager | null>(
	null,
);

/**
 * Owns one IncusEventsManager per session key. The manager is created in an
 * effect, not during render, so StrictMode's double mount disposes the first
 * one cleanly. A null key (logged out or untrusted) keeps no manager at all.
 */
export function IncusEventsProvider({
	sessionKey,
	children,
}: {
	sessionKey: string | null;
	children: ReactNode;
}) {
	const [manager, setManager] = useState<IncusEventsManager | null>(null);

	useEffect(() => {
		if (sessionKey === null) {
			return;
		}
		const next = new IncusEventsManager({
			createSocket: createBrowserSocket,
			origin: window.location.origin,
		});
		setManager(next);
		return () => {
			next.dispose();
			setManager(null);
		};
	}, [sessionKey]);

	return (
		<IncusEventsContext.Provider value={manager}>
			{children}
		</IncusEventsContext.Provider>
	);
}

/**
 * Mounts IncusEventsProvider with the current session's key. Until a trusted
 * session is known no socket is opened; a different session replaces the
 * manager, which closes the previous session's connections.
 */
export function IncusSessionEventsProvider({
	children,
}: {
	children: ReactNode;
}) {
	const session = useIncusSession();
	const sessionKey =
		session.status === "ready" ? session.session.sessionKey : null;
	return (
		<IncusEventsProvider sessionKey={sessionKey}>
			{children}
		</IncusEventsProvider>
	);
}

export function useEventsManager(): IncusEventsManager | null {
	return useContext(IncusEventsContext);
}
