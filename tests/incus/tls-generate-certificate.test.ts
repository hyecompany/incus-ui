// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { before, describe, it } from "node:test";
import forge from "node-forge";
import {
	type GeneratedCertificate,
	defaultCommonName,
	generateClientCertificate,
} from "../../src/lib/incus/tls/generate-certificate.ts";

const binary = (bytes: Uint8Array) => Buffer.from(bytes).toString("binary");

describe("generateClientCertificate", () => {
	let generated: GeneratedCertificate;
	before(async () => {
		generated = await generateClientCertificate({
			commonName: defaultCommonName("incus.example.com"),
			password: "correct horse",
			friendlyName: "Incus UI incus.example.com",
		});
	});

	it("produces a PEM certificate that parses back with the right subject and usage", () => {
		const cert = forge.pki.certificateFromPem(generated.certificatePem);
		assert.equal(
			cert.subject.getField("CN").value,
			"incus-ui@incus.example.com",
		);
		const eku = cert.getExtension("extKeyUsage") as { clientAuth?: boolean };
		assert.equal(eku.clientAuth, true);
		const keyUsage = cert.getExtension("keyUsage") as {
			digitalSignature?: boolean;
			keyEncipherment?: boolean;
		};
		assert.equal(keyUsage.digitalSignature, true);
		assert.equal(keyUsage.keyEncipherment, true);
		assert.equal(cert.siginfo.algorithmOid, forge.pki.oids.sha256WithRSAEncryption);
		assert.ok(cert.verify(cert), "self-signature verifies");
		assert.ok(cert.validity.notAfter > new Date(Date.now() + 365 * 86_400_000));
	});

	it("is accepted by Node's (OpenSSL) X.509 parser with a positive 16-byte serial", () => {
		const x509 = new X509Certificate(generated.certificatePem);
		assert.equal(x509.serialNumber.length, 32);
		assert.ok(Number.parseInt(x509.serialNumber.slice(0, 2), 16) < 0x80);
		assert.notEqual(x509.serialNumber.slice(0, 2), "00");
		assert.ok(x509.keyUsage?.includes("1.3.6.1.5.5.7.3.2"));
		assert.equal(
			x509.checkPrivateKey(createPrivateKey(generated.privateKeyPem)),
			true,
		);
	});

	it("encodes subject names as UTF8String so strict parsers (Go) accept the @", () => {
		const cert = forge.pki.certificateFromPem(generated.certificatePem);
		assert.equal(cert.subject.getField("CN").valueTagClass, forge.asn1.Type.UTF8);
		assert.equal(cert.issuer.getField("CN").valueTagClass, forge.asn1.Type.UTF8);
		// Check the DER itself: Node/OpenSSL parse a PrintableString "@" leniently, Go does not.
		const der = Buffer.from(new X509Certificate(generated.certificatePem).raw);
		const cnOid = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
		let at = der.indexOf(cnOid);
		assert.ok(at > 0, "CN attribute present");
		for (; at !== -1; at = der.indexOf(cnOid, at + 1)) {
			assert.equal(der[at + cnOid.length], 0x0c, "CN is UTF8String, not PrintableString (0x13)");
		}
		assert.match(new X509Certificate(generated.certificatePem).subject, /CN=incus-ui@incus\.example\.com/);
	});

	it("exports the key as PKCS#8", () => {
		assert.match(generated.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
		assert.equal(createPrivateKey(generated.privateKeyPem).asymmetricKeyType, "rsa");
	});

	it("reports the SHA-256 fingerprint of the certificate DER", () => {
		const cert = forge.pki.certificateFromPem(generated.certificatePem);
		const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
		const md = forge.md.sha256.create();
		md.update(der);
		assert.equal(generated.fingerprint, md.digest().toHex());
		assert.equal(
			generated.fingerprint,
			new X509Certificate(generated.certificatePem).fingerprint256
				.replaceAll(":", "")
				.toLowerCase(),
		);
	});

	it("writes a 3DES PKCS#12 that decodes with the password and holds cert and key", () => {
		const asn1 = forge.asn1.fromDer(binary(generated.pkcs12));
		const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, "correct horse");
		const certBags =
			p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ??
			[];
		const keyBags =
			p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
				forge.pki.oids.pkcs8ShroudedKeyBag
			] ?? [];
		assert.equal(certBags.length, 1);
		assert.equal(keyBags.length, 1);
		assert.equal(certBags[0].attributes.friendlyName?.[0], "Incus UI incus.example.com");
		assert.ok(certBags[0].attributes.localKeyId?.[0]);
		assert.equal(
			forge.pki.certificateToPem(certBags[0].cert as forge.pki.Certificate),
			generated.certificatePem,
		);
		const key = keyBags[0].key as forge.pki.rsa.PrivateKey;
		const expected = forge.pki.privateKeyFromPem(
			generated.privateKeyPem,
		) as forge.pki.rsa.PrivateKey;
		assert.equal(key.n.toString(16), expected.n.toString(16));
		// pbeWithSHAAnd3-KeyTripleDES-CBC
		assert.ok(binary(generated.pkcs12).includes(forge.asn1.oidToDer("1.2.840.113549.1.12.1.3").getBytes()));
	});

	it("rejects the PKCS#12 with a wrong password", () => {
		const asn1 = forge.asn1.fromDer(binary(generated.pkcs12));
		assert.throws(() => forge.pkcs12.pkcs12FromAsn1(asn1, "wrong"));
	});

	it("requires a password", async () => {
		await assert.rejects(
			generateClientCertificate({ commonName: "x", password: "" }),
		);
	});
});
