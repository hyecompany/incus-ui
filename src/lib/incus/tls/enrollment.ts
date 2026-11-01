// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { EnrollmentResult } from "../certificates.ts";
import type { SessionState } from "../session.ts";

type FailureReason = Extract<EnrollmentResult, { ok: false }>["reason"];

export interface EnrollmentFailureMessage {
	title: string;
	description: string;
	/** Whether entering another token could help. */
	retry: boolean;
}

/** Plain-language explanation of a failed enrollment. */
export function enrollmentFailureMessage(
	reason: FailureReason,
	options: { withCertificate: boolean; serverMessage?: string },
): EnrollmentFailureMessage {
	switch (reason) {
		case "invalid-token":
			return {
				title: "That trust token was not accepted",
				description:
					"Each token works only once and stops working after it expires or is revoked. Check that you pasted the whole token, or create a new one and try again.",
				retry: true,
			};
		case "already-trusted":
			return {
				title: "This certificate is already trusted",
				description:
					"The server already knows this certificate, so there is nothing to enroll. Continue to sign in with it.",
				retry: false,
			};
		case "no-certificate":
			return options.withCertificate
				? {
						title: "The server did not accept the certificate from this page",
						description:
							"Servers older than Incus 7.6 only enroll the certificate the browser itself presents. Enroll it manually with the command below, or import it into this browser first and then enroll it.",
						retry: false,
					}
				: {
						title: "Your browser did not present a certificate",
						description:
							"The server can only enroll the certificate your browser sends. Import the certificate into this browser, fully restart the browser, choose it when asked, then try again.",
						retry: false,
					};
		case "not-ca-signed":
			return {
				title: "This server only accepts certificates signed by its CA",
				description:
					"The server is in CA mode, so self-signed certificates (including ones generated here) cannot be trusted. Ask your administrator for a certificate signed by the server's certificate authority.",
				retry: false,
			};
		default:
			return {
				title: "The certificate could not be enrolled",
				description: options.serverMessage
					? `The server said: ${options.serverMessage}`
					: "The server refused the request. Try again, or enroll the certificate manually.",
				retry: true,
			};
	}
}

/** "already-trusted" means the goal is reached, so it counts as success. */
export const enrollmentSucceeded = (result: EnrollmentResult) =>
	result.ok || result.reason === "already-trusted";

export type ConnectionOutcome = "trusted" | "untrusted" | "error" | "loading";

export function connectionOutcome(state: SessionState): ConnectionOutcome {
	if (state.status === "ready")
		return state.session.trusted ? "trusted" : "untrusted";
	return state.status;
}
