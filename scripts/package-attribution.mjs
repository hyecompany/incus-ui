// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-build attribution packaging.
 * Merges Vite npm-licenses.json with src/ SPDX marks and config extras into dist/.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "build-attribution.config.json");
const distDir = path.join(root, "dist");

const PROJECT_LICENSE = "Apache-2.0";
const PROJECT_LICENSE_FILE = "LICENSE";
const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";
const LICENSES_DIR = "licenses";
const VITE_LICENSE_JSON = "npm-licenses.json";
const SCAN_ROOTS = ["src"];

function fail(message) {
	console.error(`package-attribution: ${message}`);
	process.exit(1);
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function matchGlob(relPosix, pattern) {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{GLOBSTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/{{GLOBSTAR}}/g, ".*");
	return new RegExp(`^${escaped}$`).test(relPosix);
}

function walkFiles(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, name.name);
		if (name.isDirectory()) walkFiles(full, out);
		else out.push(full);
	}
	return out;
}

function toPosix(rel) {
	return rel.split(path.sep).join("/");
}

function parseSpdxFromText(text) {
	const entries = [];
	/* REUSE-IgnoreStart: patterns look like SPDX tags to reuse lint */
	const licenseTag = "SPDX-License-Identifier";
	const copyrightTag = "SPDX-FileCopyrightText";
	const snippetCopyrightTag = "SPDX-SnippetCopyrightText";
	const fileLicense = text.match(new RegExp(`${licenseTag}:\\s*(\\S+)`));
	const fileCopyrights = [
		...text.matchAll(new RegExp(`${copyrightTag}:\\s*(.+)`, "g")),
	].map((m) => m[1].trim());
	/* REUSE-IgnoreEnd */

	if (fileLicense) {
		entries.push({
			license: fileLicense[1].trim(),
			copyrights: fileCopyrights,
			kind: "file",
		});
	}

	const snippetRe = /SPDX-SnippetBegin([\s\S]*?)SPDX-SnippetEnd/g;
	for (const block of text.matchAll(snippetRe)) {
		const body = block[1];
		/* REUSE-IgnoreStart */
		const lic = body.match(new RegExp(`${licenseTag}:\\s*(\\S+)`));
		const copyrights = [
			...body.matchAll(
				new RegExp(
					`${snippetCopyrightTag}:\\s*(.+)|${copyrightTag}:\\s*(.+)`,
					"g",
				),
			),
		].map((m) => (m[1] || m[2]).trim());
		/* REUSE-IgnoreEnd */
		if (lic) {
			entries.push({
				license: lic[1].trim(),
				copyrights,
				kind: "snippet",
			});
		}
	}

	return entries;
}

function packageLicenseCandidates(packageName) {
	if (!packageName) return [];
	const dir = path.join(root, "node_modules", ...packageName.split("/"));
	return [
		"LICENSE",
		"LICENSE.txt",
		"LICENSE.md",
		"LICENCE",
		"LICENCE.txt",
		"COPYING",
	].map((name) => path.join(dir, name));
}

function loadLicenseText(spdx, packageName) {
	const repoFile = path.join(root, "LICENSES", `${spdx}.txt`);
	if (fs.existsSync(repoFile)) {
		return fs.readFileSync(repoFile, "utf8").trim();
	}
	for (const candidate of packageLicenseCandidates(packageName)) {
		if (fs.existsSync(candidate)) {
			return fs.readFileSync(candidate, "utf8").trim();
		}
	}
	fail(
		`Missing license text for ${spdx}` +
			(packageName
				? ` (no LICENSES/${spdx}.txt and no LICENSE under node_modules/${packageName})`
				: ` at LICENSES/${spdx}.txt`),
	);
}

function tokenizeSpdxExpression(expr) {
	return expr
		.replace(/[()]/g, " ")
		.split(/\s+/)
		.filter((t) => t && t !== "AND" && t !== "OR" && t !== "WITH");
}

function knownNonApache(config) {
	return new Set(config.licenses || []);
}

function assertKnownOrApache(ids, known) {
	for (const id of ids) {
		if (id === PROJECT_LICENSE) continue;
		if (!known.has(id)) {
			fail(
				`Unknown SPDX id ${id}. Add it to "licenses" in build-attribution.config.json and ensure LICENSES/${id}.txt exists.`,
			);
		}
	}
}

function checkPreserveHeaders(config) {
	const rules = config.preserveHeaders || [];
	const errors = [];
	for (const rule of rules) {
		const required = rule.require || [];
		for (const pattern of rule.paths || []) {
			const base = pattern.includes("/**")
				? pattern.split("/**")[0]
				: pattern.includes("*")
					? path.dirname(pattern)
					: pattern;
			const absBase = path.join(root, base === "." ? "" : base);
			if (!fs.existsSync(absBase)) continue;
			const files = walkFiles(absBase).filter((full) => {
				const rel = toPosix(path.relative(root, full));
				return matchGlob(rel, pattern);
			});
			for (const full of files) {
				const text = fs.readFileSync(full, "utf8");
				const rel = toPosix(path.relative(root, full));
				for (const field of required) {
					if (!text.includes(field)) {
						errors.push(`${rel}: missing ${field}`);
					}
				}
			}
		}
	}
	if (errors.length) {
		fail(
			`preserveHeaders check failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
		);
	}
}

function collectDifferential(config) {
	const known = knownNonApache(config);
	const byLicense = new Map();

	for (const scanRoot of SCAN_ROOTS) {
		const abs = path.join(root, scanRoot);
		for (const full of walkFiles(abs)) {
			const rel = toPosix(path.relative(root, full));
			let text;
			try {
				text = fs.readFileSync(full, "utf8");
			} catch {
				continue;
			}
			for (const entry of parseSpdxFromText(text)) {
				const ids = tokenizeSpdxExpression(entry.license);
				assertKnownOrApache(ids, known);
				for (const id of ids) {
					if (id === PROJECT_LICENSE) continue;
					if (!byLicense.has(id)) {
						byLicense.set(id, {
							copyrights: new Set(),
							paths: new Set(),
						});
					}
					const bucket = byLicense.get(id);
					bucket.paths.add(rel);
					for (const c of entry.copyrights) bucket.copyrights.add(c);
				}
			}
		}
	}
	return byLicense;
}

function collectExtras(config) {
	const known = knownNonApache(config);
	const extras = [];
	for (const entry of config.extras || []) {
		if (!known.has(entry.license)) {
			fail(
				`extras ${entry.name}: license ${entry.license} must be listed under "licenses"`,
			);
		}
		if (entry.whenAssetMatches) {
			const assetsDir = path.join(distDir, "assets");
			const pattern = entry.whenAssetMatches.startsWith("assets/")
				? entry.whenAssetMatches.slice("assets/".length)
				: entry.whenAssetMatches;
			const hits = fs.existsSync(assetsDir)
				? fs
						.readdirSync(assetsDir)
						.filter((name) => matchGlob(name, pattern))
				: [];
			if (hits.length === 0) {
				console.warn(
					`package-attribution: skipping extra ${entry.name} (no assets matching ${entry.whenAssetMatches})`,
				);
				continue;
			}
		}
		extras.push(entry);
	}
	return extras;
}

function formatNpmSection(npmLicenses) {
	const lines = [
		"# Third-party notices",
		"",
		"This distribution includes software from the following npm packages (production JavaScript bundle):",
		"",
	];
	for (const pkg of npmLicenses) {
		const id = pkg.identifier || "UNKNOWN";
		lines.push(`## ${pkg.name} - ${pkg.version} (${id})`, "");
		if (pkg.text) lines.push(pkg.text.trim(), "");
		else lines.push(`_No LICENSE text found in package; SPDX: ${id}_`, "");
	}
	return lines;
}

function formatDifferentialSection(byLicense) {
	if (byLicense.size === 0) return [];
	const lines = [
		"## First-party differential material",
		"",
		"Licenses applying to identifiable parts of this project's source included in the distributed UI:",
		"",
	];
	for (const [spdx, data] of [...byLicense.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		lines.push(`### ${spdx}`, "");
		if (data.copyrights.size) {
			for (const c of [...data.copyrights].sort()) lines.push(`- ${c}`);
			lines.push("");
		}
		lines.push(`See \`licenses/${spdx}.txt\` for the full license text.`, "");
		lines.push("Source paths:", "");
		for (const p of [...data.paths].sort()) lines.push(`- \`${p}\``);
		lines.push("");
	}
	return lines;
}

function formatExtrasSection(extras) {
	if (extras.length === 0) return [];
	const lines = ["## Fonts and other bundled assets", ""];
	for (const entry of extras) {
		lines.push(`### ${entry.name} (${entry.license})`, "");
		if (entry.copyright) lines.push(entry.copyright, "");
		lines.push(
			`See \`licenses/${entry.license}.txt\` for the full license text.`,
			"",
		);
	}
	return lines;
}

function writeLicensesDir(spdxIds, packageBySpdx = {}) {
	const outDir = path.join(distDir, LICENSES_DIR);
	fs.mkdirSync(outDir, { recursive: true });
	for (const spdx of spdxIds) {
		fs.writeFileSync(
			path.join(outDir, `${spdx}.txt`),
			`${loadLicenseText(spdx, packageBySpdx[spdx])}\n`,
		);
	}
}

function main() {
	const args = new Set(process.argv.slice(2));
	const checkOnly = args.has("--check-headers-only");

	if (!fs.existsSync(configPath)) {
		fail(`Missing ${path.relative(root, configPath)}`);
	}
	const config = readJson(configPath);
	if (!Array.isArray(config.licenses)) {
		fail('build-attribution.config.json must contain a "licenses" array');
	}

	checkPreserveHeaders(config);
	if (checkOnly) {
		console.log("package-attribution: preserveHeaders OK");
		return;
	}

	if (!fs.existsSync(distDir)) fail("dist/ missing; run vite build first");

	const vitePath = path.join(distDir, VITE_LICENSE_JSON);
	if (!fs.existsSync(vitePath)) {
		fail(
			`Missing ${VITE_LICENSE_JSON} in dist/. Enable build.license in vite.config.ts.`,
		);
	}
	const npmLicenses = readJson(vitePath);
	if (!Array.isArray(npmLicenses)) fail(`${VITE_LICENSE_JSON} must be a JSON array`);

	const known = knownNonApache(config);
	const npmIds = [
		...new Set(npmLicenses.map((p) => p.identifier).filter(Boolean)),
	];
	assertKnownOrApache(npmIds, known);

	const differential = collectDifferential(config);
	const extras = collectExtras(config);

	const projectLicenseFile = path.join(root, PROJECT_LICENSE_FILE);
	if (!fs.existsSync(projectLicenseFile)) {
		fail(`Missing ${PROJECT_LICENSE_FILE}`);
	}
	fs.copyFileSync(projectLicenseFile, path.join(distDir, "LICENSE"));

	const noticeLines = [
		...formatNpmSection(npmLicenses),
		...formatDifferentialSection(differential),
		...formatExtrasSection(extras),
	];
	fs.writeFileSync(
		path.join(distDir, NOTICES_FILE),
		`${noticeLines.join("\n").trim()}\n`,
	);

	const textsNeeded = new Set([PROJECT_LICENSE, ...npmIds]);
	const packageBySpdx = {};
	for (const spdx of differential.keys()) textsNeeded.add(spdx);
	for (const entry of extras) {
		textsNeeded.add(entry.license);
		packageBySpdx[entry.license] = entry.name;
	}
	writeLicensesDir([...textsNeeded], packageBySpdx);

	fs.unlinkSync(vitePath);

	for (const rel of ["LICENSE", NOTICES_FILE]) {
		if (!fs.existsSync(path.join(distDir, rel))) {
			fail(`Expected ${rel} in dist/ after packaging`);
		}
	}
	for (const spdx of textsNeeded) {
		const licenseFile = path.join(distDir, LICENSES_DIR, `${spdx}.txt`);
		if (!fs.existsSync(licenseFile)) {
			fail(`Expected licenses/${spdx}.txt in dist/ after packaging`);
		}
	}

	console.log(
		`package-attribution: wrote dist/LICENSE, dist/${NOTICES_FILE}, dist/${LICENSES_DIR}/ (${npmLicenses.length} npm packages, ${differential.size} differential license(s), ${extras.length} extra(s))`,
	);
}

main();
