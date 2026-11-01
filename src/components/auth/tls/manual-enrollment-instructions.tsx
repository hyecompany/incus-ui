// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { CommandBlock, Step, StepList } from "@/components/auth/shared";
import { addCertificateCommand } from "@/lib/incus/tls/certificate-files";

/** How to trust a certificate file from the server's command line. */
export function ManualEnrollmentInstructions({
	certificatePath,
	certificateKnown = true,
}: {
	/** Where the .crt is on the user's machine, e.g. `~/Downloads/x.crt`. */
	certificatePath: string;
	/** False when the path is a placeholder the user must replace. */
	certificateKnown?: boolean;
}) {
	return (
		<StepList>
			<Step title="Copy the certificate file to a machine where the incus command can manage this server">
				Only the <code>.crt</code> file is needed. Never copy the{" "}
				<code>.key</code> or <code>.pfx</code> file: they are your private
				credentials. If you are not an administrator, send the <code>.crt</code>{" "}
				to one instead.
			</Step>
			<Step title="Add it to the server's trust store">
				<CommandBlock command={addCertificateCommand(certificatePath)} />
				{!certificateKnown && (
					<span>
						Replace the path with the location of your certificate file.
					</span>
				)}
			</Step>
			<Step title="Come back here and continue">
				Once the command finishes without an error, the server trusts the
				certificate.
			</Step>
		</StepList>
	);
}
