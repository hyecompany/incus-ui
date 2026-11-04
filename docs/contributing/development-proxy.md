<!--
SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
SPDX-License-Identifier: Apache-2.0
-->

# Development Proxy

The UI is served by Vite under `/ui`, and it calls the Incus API at `/1.0`. Browsers only allow this when both come from one origin, so `npm run dev` starts a small proxy that serves both from one address. The proxy also starts the Vite dev server for you.

## Quick start

1. Install dependencies with `npm ci`.
2. Check that the Incus CLI can reach a server with `incus remote list` and `incus info`.
3. Run `npm run dev`.
4. Open the URL the command prints, for example `http://127.0.0.1:3001/ui/`.

Vite's own dev server is on port 5173 and is only reached through the proxy. Use `npm run dev:vite` to run Vite alone on port 3000 when you do not need the Incus API.

## Choosing the remote

The proxy uses the same remote as the `incus` CLI, read from `config.yml` in the Incus config directory (`$INCUS_CONF`, or `~/.config/incus`). Nothing needs to be copied or configured for the proxy.

- The CLI default is used by default. Change it with `incus remote switch <name>`.
- To use another remote for one run, set `INCUS_REMOTE`, or pass `--remote`:

  ```sh
  INCUS_REMOTE=lab npm run dev
  npm run dev -- --remote lab
  ```

  `--remote` wins over `INCUS_REMOTE`. If neither is set, the CLI default is used, and `local` when there is no config.

## Remote types

- **Local socket (`unix://`, the `local` remote):** the proxy connects to the Incus Unix socket. It uses `$INCUS_SOCKET`, then `$INCUS_DIR/unix.socket`, then `/var/lib/incus/unix.socket`. Your user needs access to that socket, usually through the `incus-admin` group.
- **TLS client certificate (`auth_type: tls`, the default):** the proxy presents `client.crt` and `client.key` from the Incus config directory. If `servercerts/<remote>.crt` exists, it is trusted as the server certificate, the same way the CLI trusts a pinned server. Run any `incus` command to create the client certificate. The server must trust it, for example with `incus config trust add-certificate ~/.config/incus/client.crt`, or by adding the remote with `incus remote add` and a trust token.
- **OIDC (`auth_type: oidc`):** the proxy sends no client certificate. The UI logs in through the browser.
- **Public remotes (`public: true`):** the proxy sends no client certificate.
- **simplestreams remotes** are image servers, not the Incus API, so the proxy rejects them.

The proxy listens on plain HTTP at `127.0.0.1` only. It does not change the Incus server.

## Environment variables

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

## Troubleshooting

- **`Proxy error: ...` (502):** the proxy could not reach the Incus server. Check the remote with `incus info --remote <name>`.
- **Certificate errors on a self-signed server:** the server certificate is not pinned. Add the remote with `incus remote add <name> <address>` so the CLI pins it, then restart `npm run dev`.
- **`Port 3001 ... is already in use`:** set `DEV_PROXY_PORT`.
- **`Vite dev server exited`:** port 5173 was probably in use. Set `DEV_PROXY_APP_PORT`.
