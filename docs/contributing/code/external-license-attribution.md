<!--
SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
SPDX-License-Identifier: Apache-2.0
-->

# External License Attribution

Open [`build-attribution.config.json`](/build-attribution.config.json) when something you added will ship in the UI package (differential-licensed source under `src/`, or other redistributed material such as fonts). Update the config so packaging includes the right notices.

## Whitelist SPDX identifiers

Add the SPDX identifier to the `licenses` array if it is not already listed and is not Apache-2.0.

Packaging and CI use that list for non-Apache material under `src/` and for `extras`. If CI fails on an unknown SPDX id, add it here.

## Add extras when source marks are not enough

Most differential source under `src/` is picked up from its SPDX headers once the id is in `licenses`. Add an `extras` entry when something else ships in the archive and will not show up that way (fonts are the usual case).

For each entry:

- name: what to call it in the notices
- license: SPDX id (must also appear in `licenses`)
- copyright: optional copyright line to include
- whenAssetMatches: optional glob under `dist/assets/`; the entry is included only if something matches

## Preserve headers when needed

Use this when you check third-party files into the repo under a tree that should keep specific SPDX fields, and you want CI to enforce that.

Omit it until you have such a tree. When you do, add an object with:

- paths: globs for the files to check
- require: field names such as `SPDX-FileCopyrightText` and `SPDX-License-Identifier`
