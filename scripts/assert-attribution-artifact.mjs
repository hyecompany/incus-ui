// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Assert dist/ or a tarball contains required attribution files.
 *   node scripts/assert-attribution-artifact.mjs
 *   node scripts/assert-attribution-artifact.mjs --tar incus-ui.tar.gz
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "build-attribution.config.json");
const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";
const LICENSES_DIR = "licenses";
const PROJECT_LICENSE = "Apache-2.0";

function fail(msg) {
	console.error(`assert-attribution-artifact: ${msg}`);
	process.exit(1);
}

function matchGlob(relPosix, pattern) {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{GLOBSTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/{{GLOBSTAR}}/g, ".*");
	return new RegExp(`^${escaped}$`).test(relPosix);
}

function assetMatches(entries, pattern) {
	return entries.some(
		(e) => matchGlob(e, pattern) || matchGlob(e.replace(/^\.\//, ""), pattern),
	);
}

function requiredLicenseTexts(config, entries) {
	const required = new Set([PROJECT_LICENSE]);
	const extrasByLicense = new Map();
	for (const entry of config.extras || []) {
		if (!entry.license) continue;
		if (!extrasByLicense.has(entry.license)) {
			extrasByLicense.set(entry.license, []);
		}
		extrasByLicense.get(entry.license).push(entry);
	}

	for (const id of config.licenses || []) {
		const extras = extrasByLicense.get(id) || [];
		const gatedOnly =
			extras.length > 0 && extras.every((e) => e.whenAssetMatches);
		if (gatedOnly) {
			const applies = extras.some((e) =>
				assetMatches(entries, e.whenAssetMatches),
			);
			if (applies) required.add(id);
			continue;
		}
		required.add(id);
	}

	for (const entry of config.extras || []) {
		if (!entry.license) continue;
		if (
			entry.whenAssetMatches &&
			!assetMatches(entries, entry.whenAssetMatches)
		) {
			continue;
		}
		required.add(entry.license);
	}

	return [...required];
}

const args = process.argv.slice(2);
const tarIdx = args.indexOf("--tar");
const tarPath = tarIdx >= 0 ? args[tarIdx + 1] : null;

let entries;
if (tarPath) {
	const abs = path.isAbsolute(tarPath) ? tarPath : path.join(root, tarPath);
	if (!fs.existsSync(abs)) fail(`tarball not found: ${tarPath}`);
	entries = execFileSync("tar", ["-tzf", abs], { encoding: "utf8" })
		.trim()
		.split("\n")
		.map((l) => l.replace(/^\.\//, ""));
} else {
	const dist = path.join(root, "dist");
	if (!fs.existsSync(dist)) fail("dist/ missing");
	entries = [];
	function walk(dir, prefix = "") {
		for (const name of fs.readdirSync(dir)) {
			const full = path.join(dir, name);
			const rel = prefix ? `${prefix}/${name}` : name;
			if (fs.statSync(full).isDirectory()) walk(full, rel);
			else entries.push(rel);
		}
	}
	walk(dist);
}

if (!fs.existsSync(configPath)) {
	fail(`missing ${path.relative(root, configPath)}`);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!Array.isArray(config.licenses)) {
	fail('build-attribution.config.json must contain a "licenses" array');
}

const need = [
	"LICENSE",
	NOTICES_FILE,
	...requiredLicenseTexts(config, entries).map(
		(id) => `${LICENSES_DIR}/${id}.txt`,
	),
];

const set = new Set(entries);
const missing = need.filter((n) => !set.has(n));
if (missing.length) {
	fail(
		`missing required attribution file(s):\n${missing.map((m) => `  - ${m}`).join("\n")}`,
	);
}

if (set.has("npm-licenses.json")) {
	fail("intermediate npm-licenses.json must not be present in the artifact");
}

console.log(
	`assert-attribution-artifact: OK (${need.length} required paths present)`,
);
