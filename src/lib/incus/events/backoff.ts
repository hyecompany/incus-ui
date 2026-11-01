// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

export interface BackoffOptions {
	baseMs: number;
	factor: number;
	maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
	baseMs: 1000,
	factor: 2,
	maxMs: 30_000,
};

/**
 * Full-jitter exponential backoff. `attempt` is zero-based: the first retry
 * waits somewhere in [0, baseMs). The result never exceeds maxMs.
 */
export function backoffDelay(
	attempt: number,
	random: () => number,
	options: BackoffOptions = DEFAULT_BACKOFF,
): number {
	const ceiling = Math.min(
		options.maxMs,
		options.baseMs * options.factor ** attempt,
	);
	const fraction = Math.min(Math.max(random(), 0), 1);
	return Math.floor(fraction * ceiling);
}
