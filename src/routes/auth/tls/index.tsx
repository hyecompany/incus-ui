// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import {
	AnotherMethodLink,
	AuthBackLink,
	AuthCard,
	ChoiceItem,
	ChoiceList,
} from "@/components/auth/shared";

export const Route = createFileRoute("/auth/tls/")({
	component: TlsChooser,
});

function TlsChooser() {
	return (
		<AuthCard
			back={<AuthBackLink to="/auth" />}
			title="Sign in with a TLS client certificate"
			description="Your browser proves who you are with a certificate the server trusts. Pick how you want to get one."
			footer={<AnotherMethodLink />}
		>
			<ChoiceList label="Certificate options">
				<ChoiceItem
					title="Generate a new certificate"
					description="Create one right here in your browser, get it trusted by the server, then install it. Best if you have never signed in before."
					badge="Recommended"
					to="/auth/tls/generate"
				/>
				<ChoiceItem
					title="Use an existing certificate"
					description="You already have a certificate, for example one the incus command created or your administrator gave you."
					to="/auth/tls/existing"
				/>
				<ChoiceItem
					title="Use a client token"
					description="Paste a short-lived token from a computer whose incus command already has access. Nothing to install."
					to="/auth/tls/token"
				/>
			</ChoiceList>
		</AuthCard>
	);
}
