// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useEventsManager } from "@/components/providers/events-provider";
import { useIncusSession } from "@/components/providers/session-provider";
import { DataCore } from "@/lib/incus/data/core";
import { connectEvents } from "@/lib/incus/data/coverage";
import {
	createInstancesApi,
	type InstancesApi,
} from "@/lib/incus/data/instances";
import { createProjectsApi, type ProjectsApi } from "@/lib/incus/data/projects";
import type { SessionState } from "@/lib/incus/session";

interface DataLayer {
	core: DataCore;
	projects: ProjectsApi;
	instances: InstancesApi;
}

const DataContext = createContext<DataLayer | null>(null);

/**
 * One data layer per deployment and session: nothing learned under one
 * access context can satisfy another, and a session change discards the
 * previous layer (in-flight work from it is ignored). Event coverage comes
 * from the shared events connection.
 */
export function IncusDataProvider({ children }: { children: ReactNode }) {
	const session = useIncusSession();
	const sessionKey =
		session.status === "ready" ? session.session.sessionKey : null;
	const events = useEventsManager();
	const [layer, setLayer] = useState<DataLayer | null>(null);

	useEffect(() => {
		if (sessionKey === null) return;
		const core = new DataCore();
		setLayer({
			core,
			projects: createProjectsApi(core),
			instances: createInstancesApi(core),
		});
		const revalidate = () => core.revalidate();
		window.addEventListener("focus", revalidate);
		return () => {
			window.removeEventListener("focus", revalidate);
			core.dispose();
			setLayer(null);
		};
	}, [sessionKey]);

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
