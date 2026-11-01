// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { IncusRequestError } from "../transport.ts";

export function toIncusError(error: unknown): IncusRequestError {
	if (error instanceof IncusRequestError) return error;
	if (error instanceof Error) return new IncusRequestError(error.message, 0, 0);
	return new IncusRequestError("Incus request failed", 0, 0);
}

export type RetryPolicy = {
	attempts: number;
	retryable(error: IncusRequestError): boolean;
	delayMs(attempt: number): number;
};

// delayMs is the pause after a failed attempt, before the next one:
// 150ms after attempt 1, 400ms after attempt 2, 900ms after attempt 3.
// A 4xx status is final. Status 0 is a transport failure and is retried.
// Reads use this policy. State changes, puts, and cancels do not.
const READ_DELAYS_MS = [150, 400, 900] as const;

export const READ_POLICY: RetryPolicy = {
	attempts: 3,
	retryable(error) {
		return error.status < 400 || error.status >= 500;
	},
	delayMs(attempt) {
		const delay = READ_DELAYS_MS[attempt - 1];
		return delay ?? READ_DELAYS_MS[READ_DELAYS_MS.length - 1];
	},
};

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

// The last failure is thrown. Nothing is converted into a successful result.
export async function withRetry<T>(
	work: () => Promise<T>,
	policy: RetryPolicy,
	sleep?: (ms: number) => Promise<void>,
): Promise<T> {
	const pause = sleep ?? wait;
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await work();
		} catch (error) {
			const incusError = toIncusError(error);
			if (attempt >= policy.attempts || !policy.retryable(incusError)) {
				throw incusError;
			}
			await pause(policy.delayMs(attempt));
		}
	}
}
