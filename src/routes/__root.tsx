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
import { Toaster } from "sonner";
import { IncusSessionProvider } from "@/components/providers/session-provider";

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
			<IncusSessionProvider>
				<Outlet />
			</IncusSessionProvider>
			<Toaster
				theme="dark"
				position="bottom-right"
				richColors
				closeButton
				visibleToasts={5}
			/>
			<TanStackDevtools
				config={{
					position: "bottom-right",
				}}
				plugins={[
					{
						name: "Tanstack Router",
						render: <TanStackRouterDevtoolsPanel />,
					},
				]}
			/>
			<Scripts />
		</>
	);
}
