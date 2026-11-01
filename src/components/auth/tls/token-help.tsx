// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconChevronRight } from "@tabler/icons-react";
import { CommandBlock } from "@/components/auth/shared";

export const CLIENT_TOKEN_COMMAND = "incus remote get-client-token 24h";

/** Expandable "How do I get a token?" instructions. */
export function TokenHelp({ defaultOpen = false }: { defaultOpen?: boolean }) {
	return (
		<details
			open={defaultOpen}
			className="group rounded-lg border bg-muted/20 text-sm open:bg-muted/30"
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
				<IconChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" />
				How do I get a token?
			</summary>
			<div className="flex flex-col gap-3 px-3 pb-3 text-muted-foreground">
				<p>
					Open a terminal on a computer where the <code>incus</code> command can
					already manage this server (for example, <code>incus list</code> works
					there), and run:
				</p>
				<CommandBlock command={CLIENT_TOKEN_COMMAND} />
				<p>
					It prints one long line: copy all of it and paste it above. The token
					is signed with that computer's Incus client certificate, which this
					server already trusts, so nothing needs to be installed in this
					browser.
				</p>
				<p>
					The token always uses the CLI's default client certificate. If you
					added this server with <code>--tls-cert</code> and{" "}
					<code>--tls-key</code>, that certificate is not the one used, and the
					server will reject the token. It works when the server was added with
					a trust token (
					<code>incus remote add &lt;name&gt; &lt;token&gt;</code>) or the
					default certificate was trusted another way.
				</p>
				<p>
					<code>24h</code> is how long the token stays valid. Use a shorter time
					such as <code>1h</code> on shared computers, or a longer one such as{" "}
					<code>720h</code> (30 days). When it runs out you will be asked for a
					new one.
				</p>
				<p>
					No such computer? Ask an administrator of this server for a token, or
					use another sign-in method.
				</p>
			</div>
		</details>
	);
}
