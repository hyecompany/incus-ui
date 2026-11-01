// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Link } from "@tanstack/react-router";
import {
	AnotherMethodLink,
	AuthBackLink,
	AuthCard,
	AuthNotice,
	CommandBlock,
	Step,
	StepList,
} from "@/components/auth/shared";
import { useIncusSession } from "@/components/providers/session-provider";
import {
	remoteNameFor,
	shellQuote,
	webuiCommand,
} from "@/lib/incus/tls/certificate-files";

export const Route = createFileRoute("/auth/cli/")({
	component: CliSignIn,
});

function CliSignIn() {
	const state = useIncusSession();
	const offersTls =
		state.status === "ready" && state.session.authMethods.includes("tls");
	const remote = remoteNameFor(window.location.hostname);
	return (
		<AuthCard
			title="Sign in with Incus CLI"
			description="If the incus command on your computer can already manage this server, it can open the UI for you with its own credentials. No certificate needs to be imported into the browser."
			back={<AuthBackLink to="/auth" search={{ choose: true }} />}
			footer={<AnotherMethodLink />}
		>
			<StepList>
				<Step title="Find this server's remote name">
					<p>
						Remotes are the servers your CLI knows about. Look for the one
						pointing at <strong>{window.location.host}</strong>.
					</p>
					<CommandBlock command="incus remote list" />
				</Step>
				<Step title="Open the UI through the CLI">
					<p>
						Replace <code>{remote}</code> with the remote name from step 1 if it
						differs.
					</p>
					<CommandBlock command={webuiCommand(remote)} />
					<p>On the server itself, the local daemon is used:</p>
					<CommandBlock command="incus webui" />
				</Step>
				<Step title="Use the window it opens">
					<p>
						The CLI starts a private proxy on this computer and opens the UI at
						a <code>http://127.0.0.1</code> address, already signed in. You can
						close this tab. The session lasts as long as the command keeps
						running.
					</p>
				</Step>
			</StepList>
			<AuthNotice title="This server is not in your remote list yet?">
				Adding it requires this server to trust your CLI.{" "}
				{offersTls ? (
					<>
						<Link
							to="/auth/tls"
							className="text-foreground underline underline-offset-4"
						>
							Set up a TLS client certificate
						</Link>{" "}
						and the UI will give you the exact <code>incus remote add</code>{" "}
						command.
					</>
				) : (
					<>
						Ask an administrator for a trust token, then run{" "}
						<code>incus remote add {shellQuote(remote)} &lt;token&gt;</code>.
					</>
				)}
			</AuthNotice>
		</AuthCard>
	);
}
