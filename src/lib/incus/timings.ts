// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

export type ApiSample = {
	id: number;
	method: string;
	path: string;
	durationMs: number;
	status: number;
	bytes: number;
	ok: boolean;
};

const samples: ApiSample[] = [];
const listeners = new Set<() => void>();
let nextId = 1;
let version = 0;

const MAX_SAMPLES = 50;

export function recordApiSample(sample: Omit<ApiSample, "id">): void {
	samples.push({ ...sample, id: nextId });
	nextId += 1;
	if (samples.length > MAX_SAMPLES) samples.shift();
	version += 1;
	for (const listener of [...listeners]) listener();
}

export function subscribeApiTimings(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function apiTimingsVersion(): number {
	return version;
}

export function latestApiSample(pathname: string): ApiSample | undefined {
	for (let index = samples.length - 1; index >= 0; index -= 1) {
		const sample = samples[index];
		if (!sample) continue;
		const path = sample.path.split("?")[0] ?? sample.path;
		if (path === pathname) return sample;
	}
	return undefined;
}

export function resetApiTimingsForTests(): void {
	samples.length = 0;
	nextId = 1;
	version += 1;
}
