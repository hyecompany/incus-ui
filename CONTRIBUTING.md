<!--
SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
SPDX-License-Identifier: Apache-2.0
-->

# Contributing
All contributions to this project are made under the [Apache License, Version 2.0](./LICENSE) unless otherwise indicated & must adhere to the [Code of Conduct](https://github.com/lxc/incus-ui/blob/main/CODE_OF_CONDUCT.md).

If you'd like to help out Incus UI users or if there's something you'd like to discuss with the greater community, become a member of the [forum](https://discuss.linuxcontainers.org). This is the best place to make your voice heard and help shape the roadmap.

## Reporting Bugs & Requesting Features
If you encounter a bug or would like to request a feature, please [file an issue on our GitHub](https://github.com/lxc/incus-ui/issues/new/choose). These must be filed by humans, not LLMs.
<details>
<summary>
See more on LLMs & AI tooling
</summary>
<!--
SPDX-SnippetBegin
SPDX-SnippetCopyrightText: 2026 Stéphane Graber <stgraber@stgraber.org>
-->
<p>We do NOT allow direct filing of issues by LLMs.</p>

<p>We REQUIRE a human being to go through our issue reporting form on GitHub and accurately describe their issue and provide all needed information.</p>

<p>The more concise and to the point the issue is, the more likely it is to be understood, tracked down, and resolved quickly.</p>

<p>Long winded AI written essays can easily look overwhelming and cause our maintainers and other contributors to just entirely skip the issue to focus their energy on something else.</p>

<p>We also don't benefit from AI generated root cause analysis or proposed fixes in those issues. If you yourself understand the code base well enough to go through that content and suggested fix, then turn it into a pull request and submit it yourself. Otherwise, please limit your report to describing the issue at hand and we'll take it from there.</p>
<!-- SPDX-SnippetEnd -->
</details>

## Codebase Contributions
Contributions to the codebase should be submitted through [pull requests on our GitHub](https://github.com/lxc/incus-ui/pulls). From there they will go through review and once approved, be merged in the main branch.


If you'd like to contribute to the codebase but don't know what to start with, tackling any [unassigned, open issues](https://github.com/lxc/incus-ui/issues?q=is%3Aissue%20state%3Aopen%20no%3Aassignee) is extremely appreciated!

If you'd like to make a code contribution that is licensed differently from the rest of the project (the [Apache License, Version 2.0](/LICENSE)), follow the [Differential Code Contribution Part Guidelines](/docs/contributing/code/differential-part-guidelines.md). Follow the [REUSE Specification](https://reuse.software/spec-3.3/) to attribute the appropriate license & copyright information to your contribution.

### Development Environment
See the [development environment documentation](./docs/contributing/code/development-environment.md) for setup information.

### Commits
#### Message Structure
Commit messages are to follow the [Conventional Commits v1.0.0 specification](https://www.conventionalcommits.org/en/v1.0.0/).

The subject line of the commit message must be structured as follows:
```
[type](optional scope): [description]
```
<details>
<summary>
Supported types
</summary>
The following types are supported:
<ul>
<li><code>fix</code>: patches a bug</li>
<li><code>feat</code>: introduces a new feature</li>
<li><code>docs</code>: documentation only changes</li>
<li><code>style</code>: changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)</li>
<li><code>refactor</code>: a code change that neither fixes a bug nor adds a feature</li>
<li><code>perf</code>: a code change that improves performance</li>
<li><code>test</code>: adding missing tests or correcting existing tests</li>
<li><code>build</code>: changes that affect the build system or external dependencies (example scope: npm)</li>
<li><code>ci</code>: changes to our CI configuration files and scripts (example scope: GitHub Workflows)</li>
<li><code>chore</code>: other changes that don't modify src or test files</li>
<li><code>revert</code>: reverts a previous commit</li>
</ul>
</details>

<details>
<summary>
Supported scopes
</summary>
Scopes include, but are not limited to:
<ul>
<li><code>agents</code>: when adding or modifying agent instructions, skills, subagents, etc.</li>
</ul>
</details>

<details>
<summary>
Examples
</summary>
<ul>
<li><code>docs: add commit message rules</code></li>
<li><code>docs(agents): commit message guidelines</code></li>
</ul>
</details>


If your commit contains a breaking change, you must add a `!` after the type/scope:
```
[type](optional scope)!: [description]
```

#### Developer Certificate of Origin
In order to contribute to this project's codebase, you must certify [The Developers Certificate of Origin, Version 1.1](https://raw.githubusercontent.com/lxc/incus-ui/refs/heads/main/docs/contributing/code/DCO-1.1.txt) (The DCO) for every identifiable portion of the contribution subject to the following:
- If the [REUSE Specification, Version 3.3](https://reuse.software/spec-3.3/) (REUSE) does not indicate a license with respect to that identifiable portion, "the license indicated by REUSE with respect to that identifiable portion" is defined as the [Apache License, Version 2.0](/LICENSE).
- For the purposes of clause (a) of The DCO, the phrase "the open source license indicated in the file" shall be read as a reference to the license indicated by REUSE with respect to that identifiable portion.
- For the purposes of clause (b) of The DCO, references to the license "as indicated in the file" shall likewise be read as references to the license indicated by REUSE with respect to that identifiable portion.

<details>
<summary>
How do I certify this for a commit?
</summary>
Your certification of this for a commit is constituted by adding a line of the following form to your commit message:
<br>
<code>Signed-off-by: [Full Name] &lt;[your primary email address]&gt;</code>, with the bracketed fields replaced by your own identifying information, and the brackets themselves omitted.
<br>
<br>
<!--
SPDX-SnippetBegin
SPDX-SnippetCopyrightText: 2026 Stéphane Graber <stgraber@stgraber.org>
-->
An example of a valid sign-off line is <code>Signed-off-by: Random J Developer &lt;random@developer.org&gt;</code>.
<!--
SPDX-SnippetEnd
-->
<br>
<br>
You may find <code>git commit -s</code> useful for this purpose.
<br>
<br>
Note: The automated DCO check excludes merge commits so GitHub's <strong>Update branch</strong> action does not invalidate an otherwise compliant pull request. Do not introduce substantive changes while resolving a merge conflict: put those changes in a separate, signed, non-merge commit so the automated check certifies them.
</details>

### A Note on AI Tool Use
<!--
SPDX-SnippetBegin
SPDX-SnippetCopyrightText: 2026 Stéphane Graber <stgraber@stgraber.org>
-->
We expect everyone contributing to the Incus UI to fully own their contribution, be able to reason about it, be able to explain why things were done a particular way and act as the full owner of that code. AI tools are treated the same as traditional tooling like `sed`, `awk`, or `coccinelle`.

For the purposes of this project, AI tools CANNOT be treated as author, co-author or be credited in any way that would suggest any ownership over the contribution.

The contributor should have done all the thinking, planning, and understanding of the changes needed to resolve an issue or implement a new feature prior to using automated tooling to perform the grunt work.

<details>
<summary>
<b>For anyone with write access to the repository</b>
</summary>
NEVER run an AI agent or similar tool on a system which holds repository credentials (SSH key, GPG key, web browser cookies, ...).
<br>
<br>
The safest approach is to SSH into that environment and then extract the changes using <code>git format-patch</code>, then review and apply them to your actual tree, tweak them as needed, sign them off and then push and open the pull request.
<br>
<br>
Any potential credential compromise or loss of control should be immediately reported to <code>security@linuxcontainers.org</code>.
</details>
<!--
SPDX-SnippetEnd
-->
