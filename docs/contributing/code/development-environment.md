<!--
SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
SPDX-License-Identifier: Apache-2.0
-->

<!-- 
SPDX-SnippetBegin
SPDX-SnippetCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
-->
# Developer Environment
## Pre-requisites
- An active release of [Node.js](https://nodejs.org/en)
- The [Incus CLI client](https://linuxcontainers.org/incus/docs/main/installing/) with your [remote](https://linuxcontainers.org/incus/docs/main/remotes/) configured.
<!-- 
SPDX-SnippetEnd
-->

## Quick start
1. Install dependencies with `npm install`.
2. Check that the Incus CLI can reach a server with `incus remote list` and `incus info`.
3. Run `npm run dev`
4. Open the URL the command prints, for example `http://127.0.0.1:3001/ui/`.

## Choosing the remote
The development environment uses the same remote as the `incus` CLI, read from `config.yml` in the Incus config directory (`$INCUS_CONF`, or `~/.config/incus`).

- The CLI default is used by default. Change it with `incus remote switch <name>`.
- To use another remote for one run, set `INCUS_REMOTE`, or pass `--remote`:

  ```sh
  INCUS_REMOTE=lab npm run dev
  npm run dev -- --remote lab
  ```

  `--remote` wins over `INCUS_REMOTE`. If neither is set, the CLI default is used, and `local` when there is no config.

## Environment variables
You can change the behavior of the development environment using the following environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `INCUS_CONF` | `~/.config/incus` | Incus CLI config directory. |
| `INCUS_REMOTE` | CLI default remote | Remote to use. `--remote <name>` takes precedence. |
| `INCUS_SOCKET` | | Socket path for the `local` remote. |
| `INCUS_DIR` | `/var/lib/incus` | Used for `$INCUS_DIR/unix.socket` when `INCUS_SOCKET` is not set. |
| `DEV_PROXY_HOST` | `127.0.0.1` | Address the proxy listens on. |
| `DEV_PROXY_PORT` | `3001` | Port the proxy listens on. This is the URL to open. |
| `DEV_PROXY_APP_PORT` | `5173` | Port for the Vite dev server started by the proxy. |
| `DEV_PROXY_CROSS_ORIGIN_ISOLATION` | unset | Set to `1` to send cross-origin isolation headers for the app. |
<!-- 
SPDX-SnippetBegin
SPDX-SnippetCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
-->
| `DEV_PROXY_CONNECT_TIMEOUT_MS` | `10000` | How long the proxy waits for an upstream connect/response before returning `502`. |
<!-- 
SPDX-SnippetEnd
-->
