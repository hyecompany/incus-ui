// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	AnotherMethodLink,
	AuthBackLink,
	AuthCard,
	AuthNotice,
} from "@/components/auth/shared";
import { validateTlsFlowSearch } from "@/components/auth/tls/flow";
import { TrustTokenForm } from "@/components/auth/tls/trust-token-form";
import { useTlsSignIn } from "@/components/auth/tls/use-tls-sign-in";
import { Button } from "@/components/ui/button";
import { enrollCertificate } from "@/lib/incus/certificates";
import {
	pendingCertificate,
	setPendingCertificate,
} from "@/lib/incus/tls/pending-certificate";

export const Route = createFileRoute("/auth/tls/enroll/")({
	validateSearch: validateTlsFlowSearch,
	component: EnrollCertificate,
});

function EnrollCertificate() {
	const { source = "existing" } = Route.useSearch();
	const navigate = useNavigate();
	const { check } = useTlsSignIn();
	const [pending] = useState(pendingCertificate);
	const [presentedButUntrusted, setPresentedButUntrusted] = useState(false);
	const generated = source === "generated";

	const onEnrolled = async () => {
		if (generated) {
			setPendingCertificate(null);
			await navigate({ to: "/auth/tls/continue", search: { source } });
			return;
		}
		// The browser's own certificate was enrolled, so this connection should now be trusted.
		if ((await check()) === "untrusted") setPresentedButUntrusted(true);
	};

	return (
		<AuthCard
			back={<AuthBackLink to="/auth/tls" />}
			title="Get your certificate trusted"
			description={
				generated
					? "The server needs to know your new certificate before it lets you in. A trust token proves you are allowed to add it."
					: "The server needs to trust the certificate your browser presents. A trust token proves you are allowed to add it."
			}
			footer={
				<>
					<Link
						to="/auth/tls/manual"
						search={{ source }}
						className="underline-offset-4 hover:text-foreground hover:underline"
					>
						Enroll manually instead
					</Link>
					<AnotherMethodLink />
				</>
			}
		>
			{generated && !pending ? (
				<AuthNotice
					tone="warning"
					title="The new certificate is no longer in this page"
					action={
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void navigate({ to: "/auth/tls/generate" })}
						>
							Generate a new one
						</Button>
					}
				>
					It is kept in memory only and was lost when the page reloaded. If you
					saved the files, use “Enroll manually instead” below with the .crt
					file, or generate a new certificate.
				</AuthNotice>
			) : (
				<TrustTokenForm
					clientName="incus-ui"
					withCertificate={generated}
					enroll={(trustToken) =>
						enrollCertificate({
							trustToken,
							certificatePem: generated ? pending?.certificatePem : undefined,
						})
					}
					onEnrolled={onEnrolled}
				/>
			)}
			{presentedButUntrusted && (
				<AuthNotice
					tone="warning"
					title="Enrolled, but you are not signed in yet"
					action={
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() =>
								void navigate({
									to: "/auth/tls/continue",
									search: { source: "existing" },
								})
							}
						>
							Show me how to use it
						</Button>
					}
				>
					The server accepted the certificate, but this browser is not using it
					on this connection. Fully restart the browser and choose the
					certificate when asked.
				</AuthNotice>
			)}
		</AuthCard>
	);
}
