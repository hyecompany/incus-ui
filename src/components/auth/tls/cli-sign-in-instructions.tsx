// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { CommandBlock, Step, StepList } from "@/components/auth/shared";
import {
	defaultCertificateCopyCommand,
	remoteAddCommand,
	webuiCommand,
} from "@/lib/incus/tls/certificate-files";

/** Adds the server as an `incus` remote with this certificate, then opens the UI through `incus webui`. */
export function CliSignInInstructions({
	remote,
	url,
	certPath,
	keyPath,
	pathsKnown = true,
	os,
}: {
	remote: string;
	url: string;
	certPath: string;
	keyPath: string;
	/** False when the paths are placeholders the user must replace. */
	pathsKnown?: boolean;
	/** Picks the CLI config directory for the copy command. */
	os: "linux" | "macos";
}) {
	return (
		<StepList>
			<Step title="Add this server as a remote using your certificate">
				<CommandBlock
					command={remoteAddCommand({ remote, url, certPath, keyPath })}
				/>
				<span>
					{pathsKnown
						? "The paths assume the files are still in your Downloads folder; adjust them if you moved or renamed them."
						: "Replace the paths with the locations of your certificate and private key."}{" "}
					If asked whether to accept the server's certificate fingerprint, check
					it and answer yes. If the server does not trust the certificate yet,
					it asks for a trust token (created with{" "}
					<code>incus config trust add</code>). If a remote called{" "}
					<code>{remote}</code> already exists, pick another name.
				</span>
			</Step>
			<Step title="Open the web UI through the CLI">
				<CommandBlock command={webuiCommand(remote)} />
				<span>
					It opens the UI in your browser, already signed in. If no browser
					opens, open the address it prints. You can close this tab.
				</span>
				<span className="text-xs">
					This remote works for <code>incus webui</code>, but browser client
					tokens (<code>incus remote get-client-token</code>) need the default
					CLI certificate. To use tokens later and you don't have one yet, copy
					the files there:
				</span>
				<CommandBlock
					command={defaultCertificateCopyCommand({ os, certPath, keyPath })}
				/>
			</Step>
		</StepList>
	);
}
