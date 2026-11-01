// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconLoader2 } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	AnotherMethodLink,
	AuthCard,
	AuthNotice,
} from "@/components/auth/shared";
import { BrowserImportGuide } from "@/components/auth/tls/browser-import-guide";
import {
	serverLocation,
	validateTlsFlowSearch,
} from "@/components/auth/tls/flow";
import { useTlsSignIn } from "@/components/auth/tls/use-tls-sign-in";
import { Button } from "@/components/ui/button";
import { createAuthStorage } from "@/lib/incus/auth-storage";
import { defaultImportTarget } from "@/lib/incus/tls/browser-import";
import { certificateFileNames } from "@/lib/incus/tls/certificate-files";
import { currentPlatform } from "@/lib/platform";

export const Route = createFileRoute("/auth/tls/import/")({
	validateSearch: validateTlsFlowSearch,
	component: BrowserImport,
});

function BrowserImport() {
	const { source } = Route.useSearch();
	const navigate = useNavigate();
	const { check, checking, outcome } = useTlsSignIn();
	const [initial] = useState(() => defaultImportTarget(currentPlatform()));
	// Without a source we arrived here from the resume key, e.g. after a browser restart.
	const [resumed] = useState(
		() => !source && createAuthStorage().resume() !== null,
	);
	const { hostname, siteUrl } = serverLocation();

	useEffect(() => {
		createAuthStorage().setResume("tls-browser-import");
	}, []);

	const leave = () => createAuthStorage().setResume(null);

	return (
		<AuthCard
			wide
			title="Install the certificate in your browser"
			description="Follow the steps for your system. We picked the tabs that match this browser; switch them if they're wrong. If you close or restart the browser, this page reopens where you left off."
			footer={
				<>
					<button
						type="button"
						onClick={() => {
							leave();
							void navigate({ to: "/auth/tls" });
						}}
						className="underline-offset-4 hover:text-foreground hover:underline"
					>
						I'm not ready yet
					</button>
					<AnotherMethodLink onClick={leave} />
				</>
			}
		>
			{resumed && (
				<AuthNotice title="Welcome back">
					If you have installed the certificate and restarted the browser, test
					the connection below. Otherwise, carry on with the steps.
				</AuthNotice>
			)}
			<BrowserImportGuide
				initial={initial}
				pfxFile={
					source === "generated"
						? certificateFileNames(hostname).pfx
						: undefined
				}
				siteUrl={siteUrl}
			/>
			<AuthNotice tone="warning" title="Restart the browser completely">
				Browsers remember which certificate they sent, or that they sent none,
				until every window is closed. Reloading this page is not enough.
			</AuthNotice>
			{outcome === "untrusted" && (
				<AuthNotice
					tone="error"
					title="This browser did not present a trusted certificate"
					action={
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() =>
								void navigate({
									to: "/auth/tls/enroll",
									search: { source: "existing" },
								})
							}
						>
							Enroll the certificate
						</Button>
					}
				>
					Either no certificate was sent (fully restart the browser and pick the
					certificate when asked) or the server does not trust it yet. If it has
					never been enrolled, enroll it with a trust token.
				</AuthNotice>
			)}
			{outcome === "error" && (
				<AuthNotice tone="error" title="Could not reach the server">
					If you cancelled the certificate prompt, fully restart the browser and
					try again.
				</AuthNotice>
			)}
			<Button
				type="button"
				size="lg"
				onClick={() => void check()}
				disabled={checking}
			>
				{checking && <IconLoader2 className="motion-safe:animate-spin" />}
				Test connection
			</Button>
		</AuthCard>
	);
}
