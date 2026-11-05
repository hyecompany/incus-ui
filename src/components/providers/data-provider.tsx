// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useEventsManager } from "@/components/providers/events-provider";
import { useIncusSession } from "@/components/providers/session-provider";
import { connectEvents } from "@/lib/incus/data/coverage";
import { createDataLayer, type DataLayer } from "@/lib/incus/data/layer";
import { wipeIncusData } from "@/lib/incus/data/wipe";
import type { SessionState } from "@/lib/incus/session";

const DataContext = createContext<DataLayer | null>(null);

/** A wall-clock gap this large means the tab was suspended or frozen. */
const SUSPEND_GAP_MS = 10_000;

/** One data layer per session; a session change discards the previous one. */
export function IncusDataProvider({ children }: { children: ReactNode }) {
	const session = useIncusSession();
	const ready = session.status === "ready" ? session.session : null;
	const sessionKey = ready?.sessionKey ?? null;
	// Rebuild only when what the server supports changes, not on every session read.
	const capabilitiesKey = ready
		? [...ready.capabilities.extensions].sort().join(",")
		: "";
	const capabilities = useRef(ready?.capabilities);
	capabilities.current = ready?.capabilities;
	const events = useEventsManager();
	const [layer, setLayer] = useState<DataLayer | null>(null);
	const wasTrusted = useRef(false);

	// Trusted -> untrusted is a logout: wipe stored data in every tab (#1).
	useEffect(() => {
		if (session.status !== "ready") return;
		if (session.session.trusted) {
			wasTrusted.current = true;
		} else if (wasTrusted.current) {
			wasTrusted.current = false;
			void wipeIncusData().then((result) => {
				if (!result.complete)
					console.warn(
						"Incus UI: local data could not be fully deleted",
						result,
					);
			});
		}
	}, [session]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: capabilitiesKey stands for capabilities.
	useEffect(() => {
		if (sessionKey === null) return;
		const next = createDataLayer({
			sessionKey,
			capabilities: capabilities.current,
			onPersistenceError: (error) =>
				console.warn("Incus UI: persistence unavailable", error),
		});
		setLayer(next);

		const revalidate = () => next.core.revalidate();
		let last = Date.now();
		const tick = window.setInterval(() => {
			const now = Date.now();
			if (now - last > SUSPEND_GAP_MS) next.resumed();
			last = now;
		}, 1_000);
		const onVisibility = () => {
			if (document.visibilityState === "hidden") void next.flush();
			else next.resumed();
		};
		const onHide = () => void next.flush();
		window.addEventListener("focus", revalidate);
		document.addEventListener("visibilitychange", onVisibility);
		document.addEventListener("resume", next.resumed);
		window.addEventListener("pagehide", onHide);
		return () => {
			window.clearInterval(tick);
			window.removeEventListener("focus", revalidate);
			document.removeEventListener("visibilitychange", onVisibility);
			document.removeEventListener("resume", next.resumed);
			window.removeEventListener("pagehide", onHide);
			next.dispose();
			setLayer(null);
		};
	}, [sessionKey, capabilitiesKey]);

	useEffect(() => {
		if (!layer || !events) return;
		return connectEvents(layer.core, events);
	}, [layer, events]);

	return <DataContext.Provider value={layer}>{children}</DataContext.Provider>;
}

/** The data layer, or null until a trusted session is known. */
export function useDataLayer(): DataLayer | null {
	return useContext(DataContext);
}

/** Why there is no data layer yet, for consumers' loading and error states. */
export function useSessionState(): SessionState {
	return useIncusSession();
}
