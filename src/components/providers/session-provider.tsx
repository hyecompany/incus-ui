// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import {
	createSessionStore,
	type SessionState,
	type SessionStore,
} from "@/lib/incus/session";

const SessionContext = createContext<SessionStore | null>(null);
const LOADING: SessionState = { status: "loading" };

/** Reads the Incus session (GET /1.0) once for the whole UI. */
export function IncusSessionProvider({ children }: { children: ReactNode }) {
	const [store, setStore] = useState<SessionStore | null>(null);
	// Created in an effect so StrictMode's double mount disposes the first one.
	useEffect(() => {
		const next = createSessionStore();
		setStore(next);
		return () => next.dispose();
	}, []);
	return (
		<SessionContext.Provider value={store}>{children}</SessionContext.Provider>
	);
}

const noop = () => () => undefined;

export function useIncusSession(): SessionState {
	const store = useContext(SessionContext);
	return useSyncExternalStore(
		store?.subscribe ?? noop,
		() => store?.get() ?? LOADING,
		() => LOADING,
	);
}
