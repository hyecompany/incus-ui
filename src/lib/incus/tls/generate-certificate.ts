// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

// node-forge is used under its BSD-3-Clause license option.
import forge from "node-forge";

export interface GenerateCertificateInput {
	commonName: string;
	/** Protects the .pfx; must not be empty (macOS and Windows reject empty passwords). */
	password: string;
	/** Name shown in certificate managers; defaults to the common name. */
	friendlyName?: string;
	validityDays?: number;
	crypto?: Crypto;
	now?: Date;
}

export interface GeneratedCertificate {
	commonName: string;
	certificatePem: string;
	/** PKCS#8 (`BEGIN PRIVATE KEY`). */
	privateKeyPem: string;
	/** PKCS#12 with 3DES key encryption and an HMAC-SHA-1 MAC (macOS Keychain compatible). */
	pkcs12: Uint8Array;
	/** SHA-256 of the certificate DER, lowercase hex, as Incus shows it. */
	fingerprint: string;
	notBefore: Date;
	notAfter: Date;
}

const DEFAULT_VALIDITY_DAYS = 3650;

const toBinaryString = (bytes: Uint8Array) => {
	let out = "";
	for (const byte of bytes) out += String.fromCharCode(byte);
	return out;
};

const fromBinaryString = (binary: string) =>
	Uint8Array.from(binary, (char) => char.charCodeAt(0));

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** `incus-ui@<hostname>`, mirroring the CLI's `<user>@<host>` common names. */
export const defaultCommonName = (hostname: string) =>
	`incus-ui@${hostname || "localhost"}`;

/** Generates a self-signed TLS client certificate for Incus with its key and a .pfx bundle. */
export async function generateClientCertificate(
	input: GenerateCertificateInput,
): Promise<GeneratedCertificate> {
	if (!input.password) throw new Error("A .pfx password is required");
	const crypto = input.crypto ?? globalThis.crypto;
	const keyPair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	const pkcs8 = new Uint8Array(
		await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
	);
	const keyInfo = forge.asn1.fromDer(toBinaryString(pkcs8));
	const privateKey = forge.pki.privateKeyFromAsn1(
		keyInfo,
	) as forge.pki.rsa.PrivateKey;

	const serial = crypto.getRandomValues(new Uint8Array(16));
	// Positive and minimally encoded: strict DER parsers (Go) reject a leading zero byte.
	serial[0] = serial[0] & 0x7f || 0x01;

	const now = input.now ?? new Date();
	// Backdated a little so small clock differences with the server do not matter.
	const notBefore = new Date(now.getTime() - 5 * 60_000);
	const notAfter = new Date(
		now.getTime() + (input.validityDays ?? DEFAULT_VALIDITY_DAYS) * 86_400_000,
	);

	const cert = forge.pki.createCertificate();
	cert.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
	cert.serialNumber = toHex(serial);
	cert.validity.notBefore = notBefore;
	cert.validity.notAfter = notAfter;
	// UTF8String: forge defaults to PrintableString, which cannot hold "@" and Go rejects it.
	// @types/node-forge mistypes valueTagClass as an asn1.Class; forge reads it as the tag type.
	const utf8 = forge.asn1.Type.UTF8 as number as forge.asn1.Class;
	const subject = [
		{
			name: "organizationName",
			value: "Incus UI",
			valueTagClass: utf8,
		},
		{
			name: "commonName",
			value: input.commonName,
			valueTagClass: utf8,
		},
	];
	cert.setSubject(subject);
	cert.setIssuer(subject);
	cert.setExtensions([
		{ name: "basicConstraints", cA: false, critical: true },
		{
			name: "keyUsage",
			critical: true,
			digitalSignature: true,
			keyEncipherment: true,
		},
		{ name: "extKeyUsage", clientAuth: true },
		{ name: "subjectKeyIdentifier" },
	]);
	cert.sign(privateKey, forge.md.sha256.create());

	const der = fromBinaryString(
		forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
	);
	const fingerprint = toHex(
		new Uint8Array(await crypto.subtle.digest("SHA-256", der)),
	);

	const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], input.password, {
		algorithm: "3des",
		friendlyName: input.friendlyName ?? input.commonName,
		generateLocalKeyId: true,
	});

	return {
		commonName: input.commonName,
		certificatePem: forge.pki.certificateToPem(cert),
		privateKeyPem: forge.pki.privateKeyInfoToPem(keyInfo),
		pkcs12: fromBinaryString(forge.asn1.toDer(p12).getBytes()),
		fingerprint,
		notBefore,
		notAfter,
	};
}
