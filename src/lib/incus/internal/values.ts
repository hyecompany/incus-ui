// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Missing keys, null, arrays, and wrong-typed values are undefined.
// An empty string is a present value. Callers that want "" must write that.
export function readString(source: unknown, key: string): string | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

export function readNumber(source: unknown, key: string): number | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "number" ? value : undefined;
}

export function readBoolean(source: unknown, key: string): boolean | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "boolean" ? value : undefined;
}
