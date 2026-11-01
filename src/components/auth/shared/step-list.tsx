// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { cn } from "@/lib/ui/utils";

/** Numbered instructions; children are `<Step>`s. */
export function StepList({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<ol className={cn("flex flex-col gap-5 [counter-reset:step]", className)}>
			{children}
		</ol>
	);
}

export function Step({
	title,
	children,
}: {
	title: ReactNode;
	/** Details, commands, screenshots for this step. */
	children?: ReactNode;
}) {
	return (
		<li className="relative flex gap-3 [counter-increment:step] before:flex before:size-6 before:shrink-0 before:items-center before:justify-center before:rounded-full before:bg-primary/15 before:text-xs before:font-semibold before:text-primary before:content-[counter(step)]">
			<div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
				<div className="text-sm font-medium">{title}</div>
				{children && (
					<div className="flex flex-col gap-2 text-sm text-muted-foreground">
						{children}
					</div>
				)}
			</div>
		</li>
	);
}
