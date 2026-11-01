// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { Menu } from "@base-ui/react/menu";
import {
	IconLoader2,
	IconLogout,
	IconSelector,
	IconUserCircle,
} from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	useIncusSession,
	useSessionStore,
} from "@/components/providers/session-provider";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { createAutoSignInGuard } from "@/lib/incus/auth-picker";
import { createAuthStorage } from "@/lib/incus/auth-storage";
import type { SessionState } from "@/lib/incus/session";
import {
	isWebuiOrigin,
	type SignOutResult,
	signInLabel,
	signOut,
} from "@/lib/incus/sign-out";

const SIGN_OUT_TOAST = "auth:sign-out";

function reportSignOut(result: SignOutResult) {
	switch (result.kind) {
		case "signed-out":
			toast.success("Signed out", { id: SIGN_OUT_TOAST });
			return;
		case "certificate":
			toast.warning("Still signed in with a browser certificate", {
				id: SIGN_OUT_TOAST,
				description:
					"This browser keeps presenting a client certificate Incus trusts. To sign out, remove the certificate from the browser's certificate settings, then fully quit and reopen the browser.",
				duration: 20_000,
			});
			return;
		case "still-trusted":
			toast.warning("Still signed in", {
				id: SIGN_OUT_TOAST,
				description: `Incus trusts this connection without a sign-in (${signInLabel(result.session.authUserMethod, null, false)}), so there is nothing to sign out of.`,
				duration: 15_000,
			});
			return;
		case "webui":
			toast.info("Opened with incus webui", {
				id: SIGN_OUT_TOAST,
				description:
					"This session uses your CLI's credentials. Stop the incus webui command (Ctrl+C) in your terminal to end it.",
				duration: 15_000,
			});
			return;
		case "error":
			toast.error("Could not check whether you are signed out", {
				id: SIGN_OUT_TOAST,
				description: result.error?.message ?? "Reload the page to try again.",
			});
			return;
	}
}

/** Sidebar footer: who is signed in, how, and sign out. */
export function UserMenu() {
	const state = useIncusSession();
	const store = useSessionStore();
	const [busy, setBusy] = useState(false);
	if (state.status !== "ready" || !state.session.trusted) return null;

	const { session } = state;
	const storage = createAuthStorage();
	const webui = isWebuiOrigin(window.location);
	const method = signInLabel(
		session.authUserMethod,
		storage.lastMethod(),
		webui,
	);
	const browserCertificate =
		!webui &&
		session.authUserMethod === "tls" &&
		storage.lastMethod() !== "tls-token";
	const fullName = session.authUserName ?? "Unknown user";
	// TLS identities are 64-hex fingerprints; shorten like `incus config trust list`.
	const name = /^[0-9a-f]{64}$/.test(fullName)
		? fullName.slice(0, 12)
		: fullName;

	const run = async () => {
		if (!store) return;
		setBusy(true);
		const guard = createAutoSignInGuard();
		const result = await signOut({
			authStorage: storage,
			suppressAutoSignIn: guard.suppress,
			webui,
			refreshSession: async (): Promise<SessionState> => {
				await store.refresh();
				return store.get();
			},
		});
		setBusy(false);
		reportSignOut(result);
	};

	return (
		<SidebarMenuItem>
			<Menu.Root>
				<SidebarMenuButton
					size="lg"
					tooltip={`${fullName} · ${method}`}
					render={<Menu.Trigger />}
					className="cursor-pointer"
				>
					<IconUserCircle className="size-5!" />
					<span className="flex min-w-0 flex-1 flex-col text-left leading-tight group-data-[collapsible=icon]:hidden">
						<span className="truncate text-sm font-medium">{name}</span>
						<span className="truncate text-xs text-muted-foreground">
							{method}
						</span>
					</span>
					<IconSelector className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
				</SidebarMenuButton>
				<Menu.Portal>
					<Menu.Positioner
						side="top"
						align="start"
						sideOffset={8}
						className="z-50"
					>
						<Menu.Popup className="w-72 rounded-xl border border-sidebar-border bg-sidebar p-1.5 text-sidebar-foreground shadow-xl outline-none transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
							<div className="flex flex-col gap-0.5 px-3 py-2">
								<span className="truncate text-sm font-medium" title={fullName}>
									{name}
								</span>
								<span className="text-xs text-muted-foreground">
									Signed in with {method}
								</span>
							</div>
							{(webui || browserCertificate) && (
								<p className="px-3 pb-2 text-xs text-muted-foreground">
									{webui
										? "To end this session, stop the incus webui command in your terminal."
										: "Your browser signs in with its certificate automatically. Signing out fully requires removing it from the browser and restarting the browser."}
								</p>
							)}
							<Menu.Separator className="my-1 h-px bg-sidebar-border" />
							<Menu.Item
								disabled={busy}
								onClick={run}
								className="flex h-9 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm outline-none data-disabled:opacity-50 data-highlighted:bg-sidebar-foreground/5"
							>
								{busy ? (
									<IconLoader2 className="size-4 motion-safe:animate-spin" />
								) : (
									<IconLogout className="size-4" />
								)}
								Sign out
							</Menu.Item>
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</SidebarMenuItem>
	);
}
