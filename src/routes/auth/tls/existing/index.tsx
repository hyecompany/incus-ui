// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	AnotherMethodLink,
	AuthBackLink,
	AuthCard,
	AuthNotice,
	ChoiceItem,
	ChoiceList,
} from "@/components/auth/shared";
import { useTlsSignIn } from "@/components/auth/tls/use-tls-sign-in";

export const Route = createFileRoute("/auth/tls/existing/")({
	component: ExistingCertificate,
});

function ExistingCertificate() {
	const navigate = useNavigate();
	const { check, checking, outcome } = useTlsSignIn();

	const alreadySelected = async () => {
		// Already trusted means we are done; otherwise enroll the certificate the browser presents.
		if ((await check()) === "untrusted")
			await navigate({
				to: "/auth/tls/enroll",
				search: { source: "existing" },
			});
	};

	return (
		<AuthCard
			back={<AuthBackLink to="/auth/tls" />}
			title="Is the certificate already in this browser?"
			description="When you opened this page, your browser may have asked you to choose a certificate. The page cannot see which one (if any) was sent, so tell us."
			footer={<AnotherMethodLink />}
		>
			<ChoiceList label="Certificate status">
				<ChoiceItem
					title="Yes, it's imported and I chose it"
					description="Next, the server is asked to trust the certificate your browser presents."
					onSelect={alreadySelected}
					disabled={checking}
				/>
				<ChoiceItem
					title="No, or I'm not sure"
					description="We'll show you how to install it in your browser or use it with the incus command."
					onSelect={() =>
						void navigate({
							to: "/auth/tls/continue",
							search: { source: "existing" },
						})
					}
				/>
			</ChoiceList>
			{outcome === "error" && (
				<AuthNotice tone="error" title="Could not reach the server">
					Check your connection and try again.
				</AuthNotice>
			)}
		</AuthCard>
	);
}
