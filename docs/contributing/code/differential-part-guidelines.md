<!--
SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
SPDX-License-Identifier: Apache-2.0
-->

# Contributing Code Under a Different License

You're welcome to contribute code that's licensed differently from the rest of the project (the [Apache License, Version 2.0](/LICENSE)). When doing so, you must follow these guidelines.

## 1. Confirm the license is acceptable
We only accept contributions compatible with the Apache License, Version 2.0.

Generally:

- **Accepted:** permissive licenses like MIT, BSD (2-Clause or 3-Clause), ISC, and similar.

- **Potentially Accepted:** MPL, CDDL, and EPL. These are weak-copyleft licenses. Unlike MIT or BSD, they carry a per-file share-alike obligation: modifications to that specific file must remain under the same license if distributed. Since the obligation is ongoing, these are always reviewed on a case-by-case basis.

- **Not accepted, in any form:** GPL, LGPL, AGPL, or similar copyleft licenses. Even re-implementing similar logic after seeing copyleft code could still produce a derivative work under that code's license, so be careful!

Additional licenses we've accepted before are present in the [`/LICENSES/`](/LICENSES/) folder.

## 2. Find your license's SPDX identifier
Find your license in the [SPDX License List](https://spdx.org/licenses/) table. The value indicated in the "Identifier" column of this table is your `SPDX-License-Identifier`.

## 3. Mark Any Differential Contribution Parts
All differential contribution parts are to be indicated through the [REUSE Specification](https://reuse.software/spec-3.3/).
<details>
<summary>
More
</summary>
The example implementations below have been opinionated to make compliance with the specification easier to understand. You don't <i>have</i> to follow the opinionated implementation of REUSE outlined throughout this document. As long as your indication is compliant with the REUSE Specification, it is acceptable.
</details>



### Commentable Files

If your part is a **new file**, add a comment header of the following form:

<!-- REUSE-IgnoreStart -->

```
SPDX-FileCopyrightText: 2026 First Last <email>

SPDX-License-Identifier: MIT
```

<!-- REUSE-IgnoreEnd -->

If your part is **within an already existing file**, license the part by enclosing it in comments of the following form:

<!-- REUSE-IgnoreStart -->

```
SPDX-SnippetBegin
SPDX-SnippetCopyrightText: 2026 First Last <email>
SPDX-License-Identifier: MIT

[part]

SPDX-SnippetEnd
```

<!-- REUSE-IgnoreEnd -->

### Uncommentable Files

If your part is within an uncommentable file, add an entry to [REUSE.toml](/REUSE.toml).

## 4. Add the license to the repository

If the full text of that license isn't already in `LICENSES/`, create a new file there of form `[SPDX-License-Identifier].txt` (e.g. `MIT.txt`) with the appropriate contents. We recommend using [`reuse download`](https://reuse.readthedocs.io/en/stable/man/reuse-download.html) from the `reuse` tool.

<details>
<summary>
More on the <code>reuse</code> tool
</summary>
REUSE provides a CLI tool to simplify compliance with the REUSE specification. Installation instructions are available on <a href="https://reuse.readthedocs.io/en/stable/readme.html#install">their documentation</a>.
<br>
<br>
In addition to <code>reuse download</code>, you may find <code><a href="https://reuse.readthedocs.io/en/stable/man/reuse-lint.html">reuse lint</code></a> and <code><a href="https://reuse.readthedocs.io/en/stable/man/reuse-annotate.html">reuse annotate</code></a> to be particularly helpful.
</details>


## 5. Update packaging attribution config

Update [`build-attribution.config.json`](/build-attribution.config.json) as described in the [External License Attribution](./external-license-attribution.md) guide, if applicable.

## 6. Disclose in your Pull Request

At the beginning of your Pull Request description, list any differential licenses used in the contribution, e.g.:

```
**Differential Licenses:** MIT, ISC
```
