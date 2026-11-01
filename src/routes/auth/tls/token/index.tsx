// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	AnotherMethodLink,
	AuthBackLink,
	AuthCard,
	AuthNotice,
} from "@/components/auth/shared";
import { TokenHelp } from "@/components/auth/tls/token-help";
import { TokenSignInForm } from "@/components/auth/tls/token-sign-in-form";
import { supportsTokenLogin } from "@/lib/incus/tls/client-token";

export const Route = createFileRoute("/auth/tls/token/")({
	component: ClientTokenSignIn,
});

type Support = "checking" | "supported" | "unsupported" | "unknown";

function ClientTokenSignIn() {
	const [support, setSupport] = useState<Support>("checking");

	useEffect(() => {
		const controller = new AbortController();
		supportsTokenLogin({ signal: controller.signal }).then(
			(supported) => setSupport(supported ? "supported" : "unsupported"),
			// Unclear answer: let the user try; the sign-in explains any failure.
			() => controller.signal.aborted || setSupport("unknown"),
		);
		return () => controller.abort();
	}, []);

	return (
		<AuthCard
			back={<AuthBackLink to="/auth/tls" />}
			title="Sign in with a client token"
			description="Use a short-lived token from a computer where the Incus command line already has access to this server. Nothing needs to be installed in this browser."
			footer={<AnotherMethodLink />}
		>
			{support === "unsupported" ? (
				<AuthNotice
					tone="warning"
					title="This server does not support client tokens"
				>
					Signing in with a client token needs Incus 7.6 or newer. Use another
					sign-in method below, for example a client certificate, or ask the
					administrator to upgrade Incus.
				</AuthNotice>
			) : (
				<>
					<TokenSignInForm
						autoFocus
						onUnsupported={() => setSupport("unsupported")}
					/>
					<TokenHelp defaultOpen />
				</>
			)}
		</AuthCard>
	);
}
