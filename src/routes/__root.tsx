// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-License-Identifier: Apache-2.0

import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { EventsDevtoolsPanel } from "@/components/debug/events-devtools-panel";

import "../styles.css";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				title: "Incus UI",
			},
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument() {
	return (
		<>
			<HeadContent />
			<Outlet />
			{import.meta.env.DEV && (
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						{
							name: "Incus Events",
							render: <EventsDevtoolsPanel />,
						},
					]}
				/>
			)}
			<Scripts />
		</>
	);
}
