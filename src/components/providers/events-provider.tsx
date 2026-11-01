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

/** Owns one IncusEventsManager per session key. */
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

/** Mounts IncusEventsProvider with the current session's key. */
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
