// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import {
	IconAlertTriangle,
	IconCircleCheck,
	IconCircleX,
	IconInfoCircle,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/ui/utils";

const tones = {
	info: { icon: IconInfoCircle, className: "border-border bg-muted/40" },
	success: {
		icon: IconCircleCheck,
		className:
			"border-emerald-500/30 bg-emerald-500/10 [&>svg]:text-emerald-500",
	},
	warning: {
		icon: IconAlertTriangle,
		className: "border-amber-500/30 bg-amber-500/10 [&>svg]:text-amber-500",
	},
	error: {
		icon: IconCircleX,
		className:
			"border-destructive/40 bg-destructive/10 [&>svg]:text-destructive",
	},
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
	const { icon: Icon, className: toneClass } = tones[tone];
	return (
		<div
			role={tone === "error" ? "alert" : "status"}
			className={cn(
				"flex gap-3 rounded-lg border p-3 text-sm",
				toneClass,
				className,
			)}
		>
			<Icon className="mt-0.5 size-4 shrink-0" />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				{title && <p className="font-medium">{title}</p>}
				{children && <div className="text-muted-foreground">{children}</div>}
				{action && <div className="mt-1">{action}</div>}
			</div>
		</div>
	);
}
