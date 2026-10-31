// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

const devProxyOrigin = process.env.DEV_PROXY_PUBLIC_ORIGIN;

const devProxyServer: UserConfig["server"] = devProxyOrigin
	? {
			host: "127.0.0.1",
			port: Number(process.env.DEV_PROXY_APP_PORT ?? 5173),
			strictPort: true,
			allowedHosts: true,
			origin: devProxyOrigin,
			ws: {
				protocol: process.env.DEV_PROXY_HMR_PROTOCOL === "wss" ? "wss" : "ws",
				clientPort: Number(process.env.DEV_PROXY_PORT ?? 3000),
			},
		}
	: undefined;

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
		}),
		devtools(),
		tailwindcss(),
		viteReact(),
		babel({ presets: [reactCompilerPreset()] }),
	],
	base: "/ui",
	server: devProxyServer,
});

export default config;
