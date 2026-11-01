// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconLoader2 } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
	AnotherMethodLink,
	AuthBackLink,
	AuthCard,
	AuthNotice,
} from "@/components/auth/shared";
import {
	CertificateDownloads,
	type DownloadableFile,
} from "@/components/auth/tls/certificate-downloads";
import { serverLocation } from "@/components/auth/tls/flow";
import { SecretValue } from "@/components/auth/tls/secret-value";
import { Button } from "@/components/ui/button";
import {
	certificateFileNames,
	generatePfxPassword,
} from "@/lib/incus/tls/certificate-files";
import type { GeneratedCertificate } from "@/lib/incus/tls/generate-certificate";
import { setPendingCertificate } from "@/lib/incus/tls/pending-certificate";

export const Route = createFileRoute("/auth/tls/generate/")({
	component: GenerateRoute,
});

function GenerateRoute() {
	const [attempt, setAttempt] = useState(0);
	// Remounting starts a fresh generation.
	return (
		<GenerateCertificate
			key={attempt}
			onRetry={() => setAttempt((n) => n + 1)}
		/>
	);
}

type State =
	| { status: "generating" }
	| { status: "ready"; certificate: GeneratedCertificate; password: string }
	| { status: "error"; message: string };

function GenerateCertificate({ onRetry }: { onRetry: () => void }) {
	const navigate = useNavigate();
	const { hostname } = serverLocation();
	const names = certificateFileNames(hostname);
	const [state, setState] = useState<State>({ status: "generating" });
	const [downloaded, setDownloaded] = useState<ReadonlySet<string>>(new Set());

	useEffect(() => {
		let cancelled = false;
		(async () => {
			// node-forge is only loaded on this screen.
			const { defaultCommonName, generateClientCertificate } = await import(
				"@/lib/incus/tls/generate-certificate"
			);
			const password = generatePfxPassword();
			const certificate = await generateClientCertificate({
				commonName: defaultCommonName(hostname),
				friendlyName: `Incus UI (${hostname})`,
				password,
			});
			if (!cancelled) setState({ status: "ready", certificate, password });
		})().catch((error: unknown) => {
			if (!cancelled)
				setState({
					status: "error",
					message: error instanceof Error ? error.message : String(error),
				});
		});
		return () => {
			cancelled = true;
		};
	}, [hostname]);

	const files = useMemo<DownloadableFile[]>(() => {
		if (state.status !== "ready") return [];
		const { certificate } = state;
		return [
			{
				name: names.pfx,
				content: certificate.pkcs12,
				mimeType: "application/x-pkcs12",
				description:
					"Certificate and key for your browser, protected by the password above",
			},
			{
				name: names.crt,
				content: certificate.certificatePem,
				mimeType: "application/x-pem-file",
				description: "Public certificate, the part the server trusts",
			},
			{
				name: names.key,
				content: certificate.privateKeyPem,
				mimeType: "application/x-pem-file",
				description: "Private key for the incus command. Keep it secret",
			},
		];
	}, [state, names.pfx, names.crt, names.key]);

	const allSaved =
		files.length > 0 && files.every((f) => downloaded.has(f.name));

	const proceed = () => {
		if (state.status !== "ready") return;
		setPendingCertificate({
			certificatePem: state.certificate.certificatePem,
			fingerprint: state.certificate.fingerprint,
		});
		void navigate({ to: "/auth/tls/enroll", search: { source: "generated" } });
	};

	return (
		<AuthCard
			back={<AuthBackLink to="/auth/tls" />}
			title="Your new certificate"
			description="It was created in this browser and has not been sent anywhere. Save the password and the files now: once you leave this screen they cannot be shown again."
			footer={<AnotherMethodLink />}
		>
			{state.status === "generating" && (
				<output className="flex items-center gap-3 rounded-lg border p-4 text-sm text-muted-foreground">
					<IconLoader2 className="size-4 motion-safe:animate-spin" />
					Creating your certificate…
				</output>
			)}
			{state.status === "error" && (
				<AuthNotice
					tone="error"
					title="The certificate could not be created"
					action={
						<Button type="button" variant="outline" size="sm" onClick={onRetry}>
							Try again
						</Button>
					}
				>
					{state.message}. This browser may not support the required
					cryptography; try a current version of Chrome, Edge, Firefox or
					Safari.
				</AuthNotice>
			)}
			{state.status === "ready" && (
				<>
					<SecretValue label=".pfx password" value={state.password} />
					<AuthNotice tone="warning" title="Store this password somewhere safe">
						You need it to install the certificate in your browser. It is shown
						only once and is not saved anywhere.
					</AuthNotice>
					<CertificateDownloads
						files={files}
						downloaded={downloaded}
						onDownloaded={(saved) =>
							setDownloaded((prev) => new Set([...prev, ...saved]))
						}
					/>
					<p className="text-xs text-muted-foreground">
						Fingerprint{" "}
						<code className="break-all">{state.certificate.fingerprint}</code>
					</p>
					<Button
						type="button"
						size="lg"
						disabled={!allSaved}
						onClick={proceed}
					>
						{allSaved ? "Continue" : "Download all three files to continue"}
					</Button>
				</>
			)}
		</AuthCard>
	);
}
