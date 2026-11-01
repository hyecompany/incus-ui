// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconLoader2 } from "@tabler/icons-react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	AuthCard,
	AuthNotice,
	ChoiceItem,
	ChoiceList,
} from "@/components/auth/shared";
import { useIncusSession } from "@/components/providers/session-provider";
import {
	chooseAuthMethods,
	createAutoSignInGuard,
	lastUsedOption,
	type SignInOption,
} from "@/lib/incus/auth-picker";
import { createAuthStorage } from "@/lib/incus/auth-storage";
import { currentPlatform } from "@/lib/platform";

export const Route = createFileRoute("/auth/")({
	validateSearch: (search: Record<string, unknown>): { choose?: boolean } =>
		search.choose === true || search.choose === "true" ? { choose: true } : {},
	component: SignInPicker,
});

const OIDC_UNAVAILABLE_TOAST = "auth:oidc-unavailable";

function startOidc() {
	createAutoSignInGuard().suppress();
	createAuthStorage().setLastMethod("oidc");
	// Incus handles the whole flow and redirects back to /ui/.
	window.location.assign("/oidc/login");
}

const optionDetails: Record<
	SignInOption,
	{
		title: string;
		description: string;
		to?: string;
	}
> = {
	tls: {
		title: "TLS client certificate",
		description:
			"Sign in with a certificate trusted by this server. You can create one here, use one you already have, or paste a client token.",
		to: "/auth/tls",
	},
	oidc: {
		title: "Single sign-on (OpenID Connect)",
		description:
			"Continue to your organization's identity provider and come back signed in.",
	},
	cli: {
		title: "Sign in with Incus CLI",
		description:
			"Already use the incus command on this computer? Open the UI from it, no certificate setup needed.",
		to: "/auth/cli",
	},
};

function SignInPicker() {
	const state = useIncusSession();
	const { choose } = Route.useSearch();
	const [redirecting, setRedirecting] = useState(false);
	const session = state.status === "ready" ? state.session : null;

	const decision = useMemo(
		() =>
			session
				? chooseAuthMethods(session, currentPlatform(), {
						choose,
						// The token-expired dialog asks first; do not leave for OIDC under it.
						autoSignInSuppressed:
							createAutoSignInGuard().suppressed() ||
							createAuthStorage().lastMethod() === "tls-token",
					})
				: null,
		[session, choose],
	);
	const lastUsed = useMemo(
		() => lastUsedOption(createAuthStorage().lastMethod()),
		[],
	);

	useEffect(() => {
		if (!decision?.oidcUnavailable) return;
		toast.error("Automatic single sign-on is unavailable", {
			id: OIDC_UNAVAILABLE_TOAST,
			description:
				"user.ui.auth.auto_init_oidc is enabled, but this server does not offer OpenID Connect. Choose another sign-in method.",
			duration: 10_000,
		});
	}, [decision?.oidcUnavailable]);

	useEffect(() => {
		if (decision?.redirect !== "oidc") return;
		setRedirecting(true);
		startOidc();
	}, [decision?.redirect]);

	// The auth layout only renders this once the session is ready.
	if (!decision) return null;
	if (decision.redirect === "tls") return <Navigate to="/auth/tls" replace />;
	if (decision.redirect === "cli") return <Navigate to="/auth/cli" replace />;
	if (decision.redirect === "oidc" || redirecting) {
		return (
			<AuthCard
				title="Redirecting to single sign-on…"
				description="You will come back here once your identity provider signs you in."
			>
				<IconLoader2 className="size-5 self-center text-muted-foreground motion-safe:animate-spin" />
			</AuthCard>
		);
	}

	return (
		<AuthCard
			title="Sign in to Incus"
			description="This server needs to know who you are before it shows anything. Pick how you want to sign in."
		>
			{decision.options.length === 0 ? (
				<AuthNotice tone="warning" title="No sign-in method is available">
					This server does not advertise a sign-in method this UI supports. Ask
					an administrator to enable TLS client certificates or OpenID Connect,
					or open the UI with <code>incus webui</code> from a computer that
					already has CLI access.
				</AuthNotice>
			) : (
				<ChoiceList label="Sign-in methods">
					{decision.options.map((option) => {
						const details = optionDetails[option];
						return (
							<ChoiceItem
								key={option}
								title={details.title}
								description={details.description}
								to={details.to}
								badge={option === lastUsed ? "Last used" : undefined}
								onSelect={
									option === "oidc"
										? () => {
												setRedirecting(true);
												startOidc();
											}
										: undefined
								}
							/>
						);
					})}
				</ChoiceList>
			)}
		</AuthCard>
	);
}
