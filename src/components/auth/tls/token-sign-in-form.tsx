// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconLoader2 } from "@tabler/icons-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { AuthNotice } from "@/components/auth/shared";
import { useSessionStore } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { createAuthStorage } from "@/lib/incus/auth-storage";
import {
	describeTokenFailure,
	loginWithToken,
	normalizeToken,
	rememberTokenSignIn,
	type TokenFailure,
} from "@/lib/incus/tls/client-token";

export function formatTokenTime(exp: number): string {
	return new Date(exp * 1000).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

/** Token field and "Sign in" button; on success the session is re-checked. */
export function TokenSignInForm({
	onUnsupported,
	autoFocus = false,
}: {
	/** Called when the server turns out not to have `/tls/login`. */
	onUnsupported?: () => void;
	autoFocus?: boolean;
}) {
	const fieldId = useId();
	const errorId = useId();
	const sessionStore = useSessionStore();
	const [token, setToken] = useState("");
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<TokenFailure | null>(null);
	const [stillUntrusted, setStillUntrusted] = useState(false);
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (autoFocus) fieldRef.current?.focus();
	}, [autoFocus]);
	const empty = normalizeToken(token) === "";

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (empty || pending) return;
		setPending(true);
		setFailure(null);
		setStillUntrusted(false);
		const result = await loginWithToken(token);
		if (result.ok) {
			rememberTokenSignIn(createAuthStorage(), result.exp);
			setToken("");
			await sessionStore?.refresh();
			const state = sessionStore?.get();
			setStillUntrusted(state?.status === "ready" && !state.session.trusted);
			setPending(false);
			return;
		}
		setPending(false);
		setFailure(result);
		if (result.reason === "unsupported") onUnsupported?.();
	}

	const copy = failure && describeTokenFailure(failure, formatTokenTime);

	return (
		<form onSubmit={submit} className="flex flex-col gap-3">
			<label htmlFor={fieldId} className="text-sm font-medium">
				Client token
			</label>
			<textarea
				id={fieldId}
				value={token}
				onChange={(event) => {
					setToken(event.target.value);
					setFailure(null);
				}}
				// Keep autofill and spellcheck services away from the token.
				autoComplete="off"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				ref={fieldRef}
				rows={4}
				placeholder="eyJhbGciOi…"
				aria-invalid={failure !== null}
				aria-describedby={failure ? errorId : undefined}
				disabled={pending}
				className="min-h-24 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-5 break-all outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30"
			/>
			{copy && (
				<AuthNotice tone="error" title={copy.title} className="break-words">
					<span id={errorId}>{copy.detail}</span>
				</AuthNotice>
			)}
			{stillUntrusted && (
				<AuthNotice
					tone="warning"
					title="The token was accepted, but you are not signed in yet"
				>
					The server set its sign-in cookie, but this browser did not send it
					back. Make sure cookies are allowed for this site, then try again.
				</AuthNotice>
			)}
			<Button type="submit" size="lg" disabled={empty || pending}>
				{pending && (
					<IconLoader2 className="animate-spin motion-reduce:animate-none" />
				)}
				{pending ? "Signing in…" : "Sign in"}
			</Button>
		</form>
	);
}
