// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useSessionStore } from "@/components/providers/session-provider";
import { createAuthStorage } from "@/lib/incus/auth-storage";
import {
	type ConnectionOutcome,
	connectionOutcome,
} from "@/lib/incus/tls/enrollment";

/** Re-checks /1.0; when the browser's certificate is now trusted, records the method and goes home. */
export function useTlsSignIn() {
	const store = useSessionStore();
	const navigate = useNavigate();
	const [outcome, setOutcome] = useState<ConnectionOutcome | null>(null);
	const [checking, setChecking] = useState(false);

	const check = useCallback(async () => {
		if (!store) return "loading" as const;
		setChecking(true);
		try {
			await store.refresh();
			const next = connectionOutcome(store.get());
			if (next === "trusted") {
				const storage = createAuthStorage();
				storage.setLastMethod("tls");
				storage.setResume(null);
				await navigate({ to: "/" });
			}
			setOutcome(next);
			return next;
		} finally {
			setChecking(false);
		}
	}, [store, navigate]);

	return { check, outcome, checking };
}
