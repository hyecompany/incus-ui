// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/** The public half of a just-generated certificate, kept in memory only so enrollment can send it. */
export interface PendingCertificate {
	certificatePem: string;
	fingerprint: string;
}

let pending: PendingCertificate | null = null;

export const pendingCertificate = () => pending;

export function setPendingCertificate(value: PendingCertificate | null) {
	pending = value;
}
