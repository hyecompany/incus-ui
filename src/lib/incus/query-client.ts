// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import { QueryClient } from "@tanstack/react-query";
import { IncusRequestError } from "./transport.ts";

export function createIncusQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				retry(failureCount, error) {
					if (
						error instanceof IncusRequestError &&
						error.status >= 400 &&
						error.status < 500
					) {
						return false;
					}
					return failureCount < 2;
				},
				refetchOnWindowFocus: false,
			},
		},
	});
}

export const incusQueryClient = createIncusQueryClient();
