// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconLoader2 } from "@tabler/icons-react";
import { type FormEvent, useId, useState } from "react";
import { AuthNotice, CommandBlock } from "@/components/auth/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EnrollmentResult } from "@/lib/incus/certificates";
import { trustTokenCommand } from "@/lib/incus/tls/certificate-files";
import {
	type EnrollmentFailureMessage,
	enrollmentFailureMessage,
	enrollmentSucceeded,
} from "@/lib/incus/tls/enrollment";

/** Explains how to get a trust token, takes one, and runs `enroll` with it. */
export function TrustTokenForm({
	enroll,
	onEnrolled,
	withCertificate,
	clientName,
	submitLabel = "Enroll certificate",
}: {
	enroll: (trustToken: string) => Promise<EnrollmentResult>;
	onEnrolled: () => void | Promise<void>;
	/** Whether `enroll` sends a certificate body (changes failure wording). */
	withCertificate: boolean;
	/** Suggested name for `incus config trust add`. */
	clientName: string;
	submitLabel?: string;
}) {
	const id = useId();
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<EnrollmentFailureMessage | null>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!token.trim() || busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const result = await enroll(token);
			if (enrollmentSucceeded(result)) {
				await onEnrolled();
				return;
			}
			if (!result.ok)
				setFailure(
					enrollmentFailureMessage(result.reason, {
						withCertificate,
						serverMessage: result.error.message,
					}),
				);
		} catch (error) {
			setFailure(
				enrollmentFailureMessage("other", {
					withCertificate,
					serverMessage: error instanceof Error ? error.message : undefined,
				}),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={submit} className="flex flex-col gap-5">
			<div className="flex flex-col gap-2 text-sm text-muted-foreground">
				<p>
					A trust token is a one-time code that lets this certificate join the
					server's trusted clients. If you can run <code>incus</code> commands
					on the server, create one with:
				</p>
				<CommandBlock command={trustTokenCommand(clientName)} />
				<p>
					Otherwise, ask your administrator to run it and send you the token it
					prints.
				</p>
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={`${id}-token`} className="text-sm font-medium">
					Trust token
				</label>
				<Input
					id={`${id}-token`}
					value={token}
					onChange={(event) => setToken(event.target.value)}
					placeholder="Paste the token here"
					autoComplete="off"
					spellCheck={false}
					aria-invalid={failure?.retry ? true : undefined}
					className="font-mono"
				/>
			</div>
			{failure && (
				<AuthNotice tone="error" title={failure.title}>
					{failure.description}
				</AuthNotice>
			)}
			<Button type="submit" size="lg" disabled={!token.trim() || busy}>
				{busy && <IconLoader2 className="motion-safe:animate-spin" />}
				{busy ? "Enrolling…" : submitLabel}
			</Button>
		</form>
	);
}
