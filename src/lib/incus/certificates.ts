// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IncusApiError, incusRequest } from "./client.ts";

export type EnrollmentResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "invalid-token"
				| "already-trusted"
				| "no-certificate"
				| "not-ca-signed"
				| "other";
			error: IncusApiError;
	  };

/**
 * Enrolls a client certificate with a trust token (`POST /1.0/certificates`).
 * With `certificatePem`, that certificate is enrolled (Incus 7.6+); without it,
 * the certificate the browser presented on this connection is enrolled.
 */
export async function enrollCertificate(
	input: { trustToken: string; certificatePem?: string },
	opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<EnrollmentResult> {
	const body: Record<string, string> = { trust_token: input.trustToken.trim() };
	if (input.certificatePem) body.certificate = input.certificatePem;
	try {
		await incusRequest("/1.0/certificates", { ...opts, method: "POST", body });
		return { ok: true };
	} catch (cause) {
		if (!(cause instanceof IncusApiError)) throw cause;
		const message = cause.message.toLowerCase();
		const reason = message.includes("already trusted")
			? "already-trusted"
			: message.includes("no client certificate")
				? "no-certificate"
				: message.includes("isn't signed by the ca")
					? "not-ca-signed"
					: cause.kind === "forbidden" ||
							message.includes("certificate add operation")
						? "invalid-token"
						: "other";
		return { ok: false, reason, error: cause };
	}
}
