// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { cn } from "@/lib/ui/utils";

const tones = {
	info: "border-border bg-muted/40",
	success: "border-emerald-500/30 bg-emerald-500/10",
	warning: "border-amber-500/30 bg-amber-500/10",
	error: "border-destructive/40 bg-destructive/10",
} as const;

/** Inline callout for errors, warnings and tips inside an `AuthCard`. */
export function AuthNotice({
	tone = "info",
	title,
	children,
	action,
	className,
}: {
	tone?: keyof typeof tones;
	title?: ReactNode;
	children?: ReactNode;
	/** e.g. a retry button. */
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			role={tone === "error" ? "alert" : "status"}
			className={cn(
				"flex flex-col gap-1 rounded-lg border p-3 text-sm",
				tones[tone],
				className,
			)}
		>
			{title && <p className="font-medium">{title}</p>}
			{children && <div className="text-muted-foreground">{children}</div>}
			{action && <div className="mt-1">{action}</div>}
		</div>
	);
}
