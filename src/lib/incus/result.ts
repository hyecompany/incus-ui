// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { toIncusError } from "./internal/request.ts";
import type { IncusRequestError } from "./transport.ts";

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
		// Absent stays null. toIncusError always returns an error object.
		error: query.error ? toIncusError(query.error) : null,
	};
}
