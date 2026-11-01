// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	AnotherMethodLink,
	AuthBackLink,
	AuthCard,
	AuthNotice,
} from "@/components/auth/shared";
import {
	EXISTING_CERT_PATH,
	serverLocation,
	validateTlsFlowSearch,
} from "@/components/auth/tls/flow";
import { ManualEnrollmentInstructions } from "@/components/auth/tls/manual-enrollment-instructions";
import { useTlsSignIn } from "@/components/auth/tls/use-tls-sign-in";
import { Button } from "@/components/ui/button";
import {
	certificateFileNames,
	downloadsPath,
} from "@/lib/incus/tls/certificate-files";

export const Route = createFileRoute("/auth/tls/manual/")({
	validateSearch: validateTlsFlowSearch,
	component: ManualEnrollment,
});

function ManualEnrollment() {
	const { source = "existing" } = Route.useSearch();
	const navigate = useNavigate();
	const { check, checking, outcome } = useTlsSignIn();
	const generated = source === "generated";

	const done = async () => {
		// An already-selected existing certificate may now be trusted on this very connection.
		if (!generated && (await check()) !== "untrusted") return;
		await navigate({ to: "/auth/tls/continue", search: { source } });
	};

	return (
		<AuthCard
			back={<AuthBackLink to="/auth/tls" />}
			title="Enroll the certificate manually"
			description="Add the certificate to the server's trusted clients with the incus command. Only someone who can already manage the server can do this."
			footer={
				<>
					<Link
						to="/auth/tls/enroll"
						search={{ source }}
						className="underline-offset-4 hover:text-foreground hover:underline"
					>
						Use a trust token instead
					</Link>
					<AnotherMethodLink />
				</>
			}
		>
			<ManualEnrollmentInstructions
				certificatePath={
					generated
						? downloadsPath(certificateFileNames(serverLocation().hostname).crt)
						: EXISTING_CERT_PATH
				}
				certificateKnown={generated}
			/>
			{outcome === "error" && (
				<AuthNotice tone="error" title="Could not reach the server">
					Check your connection and try again.
				</AuthNotice>
			)}
			<Button type="button" size="lg" onClick={done} disabled={checking}>
				It's added, continue
			</Button>
		</AuthCard>
	);
}
