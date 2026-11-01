// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { SessionError, SessionLoading } from "@/components/auth/shared";
import { TokenExpiredDialog } from "@/components/auth/tls/token-expired-dialog";
import { useIncusSession } from "@/components/providers/session-provider";
import { createAuthStorage } from "@/lib/incus/auth-storage";

export const Route = createFileRoute("/auth")({
	component: AuthLayout,
});

function AuthLayout() {
	const state = useIncusSession();
	const trusted = state.status === "ready" && state.session.trusted;
	useEffect(() => {
		if (trusted) createAuthStorage().setResume(null);
	}, [trusted]);

	if (state.status === "loading") return <SessionLoading />;
	if (state.status === "error") return <SessionError error={state.error} />;
	if (trusted) return <Navigate to="/" replace />;
	return (
		<main className="relative flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-4 sm:p-8">
			<div className="flex items-center gap-3">
				<img
					src="https://linuxcontainers.org/static/img/containers.svg"
					alt=""
					className="size-9"
				/>
				<span className="text-lg font-semibold">Incus UI</span>
			</div>
			<Outlet />
			<TokenExpiredDialog />
		</main>
	);
}
