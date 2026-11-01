// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { Dialog } from "@base-ui/react/dialog";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useReducer } from "react";
import { useIncusSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { createAuthStorage } from "@/lib/incus/auth-storage";
import {
	forgetTokenSignIn,
	shouldOfferNewToken,
	tokenSessionEnd,
} from "@/lib/incus/tls/client-token";
import { TokenHelp } from "./token-help";
import { formatTokenTime, TokenSignInForm } from "./token-sign-in-form";

const TOKEN_ROUTE = "/auth/tls/token";

/** Shown when a client-token session ends: paste a new token or pick another method. */
export function TokenExpiredDialog() {
	const state = useIncusSession();
	const navigate = useNavigate();
	const pathname = useLocation({ select: (location) => location.pathname });
	// Storage is not reactive: re-render after clearing the hints.
	const [, rerender] = useReducer((count: number) => count + 1, 0);
	const storage = createAuthStorage();
	const open =
		!pathname.replace(/\/+$/, "").endsWith(TOKEN_ROUTE) &&
		shouldOfferNewToken(state, storage.lastMethod());
	const end = tokenSessionEnd(storage.tokenExp());

	function chooseAnotherMethod() {
		forgetTokenSignIn(storage);
		rerender();
		void navigate({ to: "/auth", search: { choose: true } });
	}

	return (
		<Dialog.Root
			open={open}
			disablePointerDismissal
			onOpenChange={(next) => {
				if (!next) chooseAnotherMethod();
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs motion-reduce:transition-none" />
				<Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-2xl border bg-popover p-6 text-sm text-popover-foreground shadow-lg transition duration-150 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none sm:p-8">
					<div className="flex flex-col gap-2">
						<Dialog.Title className="text-lg font-semibold tracking-tight">
							{end.kind === "expired"
								? "Your client token has expired"
								: "Your client token is no longer accepted"}
						</Dialog.Title>
						<Dialog.Description className="text-muted-foreground">
							{end.kind === "expired"
								? `The token you signed in with stopped working at ${formatTokenTime(end.exp)}.`
								: "The server stopped accepting the token you signed in with. It may have been signed out elsewhere, or the certificate that signed it is no longer trusted."}{" "}
							Paste a new token to keep working.
						</Dialog.Description>
					</div>
					<TokenSignInForm autoFocus />
					<TokenHelp />
					<Button variant="ghost" onClick={chooseAnotherMethod}>
						Use another sign-in method
					</Button>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
