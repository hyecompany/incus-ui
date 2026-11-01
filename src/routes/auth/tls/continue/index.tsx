// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconArrowLeft } from "@tabler/icons-react";
import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import {
	AnotherMethodLink,
	AuthBackLink,
	AuthCard,
	ChoiceItem,
	ChoiceList,
} from "@/components/auth/shared";
import { CliSignInInstructions } from "@/components/auth/tls/cli-sign-in-instructions";
import {
	EXISTING_CERT_PATH,
	EXISTING_KEY_PATH,
	serverLocation,
	type TlsFlowSearch,
	validateTlsFlowSearch,
} from "@/components/auth/tls/flow";
import {
	certificateFileNames,
	downloadsPath,
	remoteNameFor,
} from "@/lib/incus/tls/certificate-files";
import { currentPlatform, supportsCliFlows } from "@/lib/platform";

export const Route = createFileRoute("/auth/tls/continue/")({
	validateSearch: (
		search: Record<string, unknown>,
	): TlsFlowSearch & { via?: "cli" } => ({
		...validateTlsFlowSearch(search),
		...(search.via === "cli" ? { via: "cli" as const } : {}),
	}),
	beforeLoad: ({ search }) => {
		// Only Linux and macOS get the CLI choice; everyone else goes straight to the browser steps.
		if (!supportsCliFlows(currentPlatform()))
			throw redirect({
				to: "/auth/tls/import",
				search: { source: search.source },
				replace: true,
			});
	},
	component: GeneralAuthentication,
});

function GeneralAuthentication() {
	const { source, via } = Route.useSearch();
	const navigate = useNavigate();
	const generated = source === "generated";

	if (via === "cli") {
		const { hostname, origin } = serverLocation();
		const files = certificateFileNames(hostname);
		return (
			<AuthCard
				back={
					<Link
						to="/auth/tls/continue"
						search={{ source }}
						className="-ml-1 inline-flex w-fit items-center gap-1 rounded-md px-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						<IconArrowLeft className="size-4" />
						Choose again
					</Link>
				}
				title="Sign in with the incus command"
				description="Run these two commands in a terminal on this computer. The first teaches the incus command about this server and your certificate; the second opens this UI already signed in."
				footer={<AnotherMethodLink />}
			>
				<CliSignInInstructions
					os={currentPlatform().os === "macos" ? "macos" : "linux"}
					remote={remoteNameFor(hostname)}
					url={origin}
					certPath={generated ? downloadsPath(files.crt) : EXISTING_CERT_PATH}
					keyPath={generated ? downloadsPath(files.key) : EXISTING_KEY_PATH}
					pathsKnown={generated}
				/>
			</AuthCard>
		);
	}

	return (
		<AuthCard
			back={<AuthBackLink to="/auth/tls" />}
			title="How do you want to use the certificate?"
			description="Your certificate can sign you in through the incus command on this computer, or directly in this browser."
			footer={<AnotherMethodLink />}
		>
			<ChoiceList label="Ways to sign in">
				<ChoiceItem
					title="Sign in with CLI"
					description="Two commands, no browser setup. Needs the incus command installed on this computer."
					badge="Quickest"
					onSelect={() =>
						void navigate({
							to: "/auth/tls/continue",
							search: { source, via: "cli" },
						})
					}
				/>
				<ChoiceItem
					title="Continue in browser"
					description="Install the certificate in this browser, then restart it. Works without the incus command."
					onSelect={() =>
						void navigate({ to: "/auth/tls/import", search: { source } })
					}
				/>
			</ChoiceList>
		</AuthCard>
	);
}
