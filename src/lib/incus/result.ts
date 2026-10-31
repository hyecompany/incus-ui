// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { IncusRequestError } from "./transport.ts";

export type DataResult<T> = {
	data: T | undefined;
	available: boolean;
	complete: boolean;
	fresh: boolean;
	fetching: boolean;
	error: IncusRequestError | null;
};

export function toDataResult<T>(query: {
	data: T | undefined;
	error: unknown;
	isFetching: boolean;
	isSuccess: boolean;
	isPlaceholderData: boolean;
}): DataResult<T> {
	const succeeded = query.isSuccess && !query.isPlaceholderData;
	return {
		data: query.data,
		available: query.data !== undefined,
		complete: succeeded,
		fresh: succeeded && !query.isFetching,
		fetching: query.isFetching,
		error: asIncusError(query.error),
	};
}

function asIncusError(error: unknown): IncusRequestError | null {
	if (!error) return null;
	if (error instanceof IncusRequestError) return error;
	if (error instanceof Error) return new IncusRequestError(error.message, 0, 0);
	return new IncusRequestError("Incus request failed", 0, 0);
}
