// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

export interface CertificateFileNames {
	crt: string;
	key: string;
	pfx: string;
}

const slug = (value: string, fallback: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "") || fallback;

/** Download names for a certificate generated for `hostname`; stable so later screens can rebuild them. */
export function certificateFileNames(hostname: string): CertificateFileNames {
	const base = `incus-ui-${slug(hostname, "incus")}`;
	return { crt: `${base}.crt`, key: `${base}.key`, pfx: `${base}.pfx` };
}

/** A valid `incus remote` name for the server (no `:`, `/` or `=`). */
export const remoteNameFor = (hostname: string) => slug(hostname, "incus");

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX shell quoting that keeps a leading `~/` unquoted so the shell still expands it. */
export function shellQuote(value: string): string {
	if (value.startsWith("~/")) {
		const rest = value.slice(2);
		return rest ? `~/${shellQuote(rest)}` : "~/";
	}
	if (SAFE.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const downloadsPath = (file: string) => `~/Downloads/${file}`;

export function remoteAddCommand(input: {
	remote: string;
	url: string;
	certPath: string;
	keyPath: string;
}): string {
	return [
		"incus remote add",
		shellQuote(input.remote),
		shellQuote(input.url),
		"--auth-type=tls",
		`--tls-cert ${shellQuote(input.certPath)}`,
		`--tls-key ${shellQuote(input.keyPath)}`,
	].join(" ");
}

export const webuiCommand = (remote: string) =>
	`incus webui ${shellQuote(`${remote}:`)}`;

/** Run on the server (or by an administrator) to issue a single-use trust token. */
export const trustTokenCommand = (clientName: string) =>
	`incus config trust add ${shellQuote(clientName)}`;

export const addCertificateCommand = (certPath: string) =>
	`incus config trust add-certificate ${shellQuote(certPath)}`;

/** The incus CLI config dir (os.UserConfigDir()/incus), as a shell word. */
export const cliConfigDir = (os: "linux" | "macos") =>
	os === "macos"
		? `"$HOME/Library/Application Support/incus"`
		: "~/.config/incus";

/** Makes the files the CLI's default certificate, which `incus remote get-client-token` signs with; `-n` keeps an existing one. */
export function defaultCertificateCopyCommand(input: {
	os: "linux" | "macos";
	certPath: string;
	keyPath: string;
}): string {
	const dir = cliConfigDir(input.os);
	return `mkdir -p ${dir} && cp -n ${shellQuote(input.certPath)} ${dir}/client.crt && cp -n ${shellQuote(input.keyPath)} ${dir}/client.key`;
}

const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Readable random password for the .pfx, e.g. `k7mzq-3hd8w-...` (about 99 bits). */
export function generatePfxPassword(
	crypto: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
	groups = 4,
): string {
	const out: string[] = [];
	// 248 is the largest multiple of 31 below 256: rejection keeps the choice uniform.
	while (out.length < groups * 5) {
		for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
			if (byte < 248 && out.length < groups * 5)
				out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
		}
	}
	return Array.from({ length: groups }, (_, i) =>
		out.slice(i * 5, i * 5 + 5).join(""),
	).join("-");
}
