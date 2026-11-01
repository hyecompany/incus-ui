// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { SessionError, SessionLoading } from "@/components/auth/shared";
import { View } from "@/components/layout/view";
import { UiSidebar } from "@/components/navigation/sidebar";
import { EventToasts } from "@/components/notifications/event-toasts";
import { IncusDataProvider } from "@/components/providers/data-provider";
import { IncusSessionEventsProvider } from "@/components/providers/events-provider";
import { ProjectScopeProvider } from "@/components/providers/project-scope-provider";
import { useIncusSession } from "@/components/providers/session-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { createAuthStorage } from "@/lib/incus/auth-storage";

export const Route = createFileRoute("/_ui")({
	component: RouteComponent,
});

function RouteComponent() {
	const state = useIncusSession();
	const trusted = state.status === "ready" && state.session.trusted;
	// Signed in (e.g. after a browser restart): nothing left to resume.
	useEffect(() => {
		if (trusted) createAuthStorage().setResume(null);
	}, [trusted]);
	if (state.status === "loading") return <SessionLoading />;
	if (state.status === "error") return <SessionError error={state.error} />;
	if (!state.session.trusted) {
		// Resume a certificate import interrupted by a browser restart.
		return createAuthStorage().resume() === "tls-browser-import" ? (
			<Navigate to="/auth/tls/import" replace />
		) : (
			<Navigate to="/auth" replace />
		);
	}
	return (
		<ProjectScopeProvider>
			<IncusSessionEventsProvider>
				<IncusDataProvider>
					<EventToasts />
					<SidebarProvider
						defaultOpen={false}
						style={
							{
								"--header-height": "calc(var(--spacing) * 12)", // Maybe increase back to 12 (Hye Ararat)
							} as React.CSSProperties
						}
					>
						<UiSidebar />
						<SidebarInset>
							<View>
								<Outlet />
							</View>
						</SidebarInset>
					</SidebarProvider>
				</IncusDataProvider>
			</IncusSessionEventsProvider>
		</ProjectScopeProvider>
	);
}
