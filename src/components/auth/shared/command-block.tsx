// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/lib/ui/utils";
import { CopyButton } from "./copy-button";

/** A monospace command (or URL) with a copy button. */
export function CommandBlock({
	command,
	label,
	prompt = true,
	className,
}: {
	command: string;
	/** Optional caption above the block, e.g. "On the server". */
	label?: string;
	/** Show a leading `$` (off for URLs and file contents). */
	prompt?: boolean;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			{label && <p className="text-xs text-muted-foreground">{label}</p>}
			<div className="flex items-start gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3">
				<pre className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[13px] leading-5 whitespace-pre-wrap break-all">
					{prompt && (
						<span
							aria-hidden="true"
							className="mr-2 text-muted-foreground select-none"
						>
							$
						</span>
					)}
					<code>{command}</code>
				</pre>
				<CopyButton
					value={command}
					label={`Copy ${prompt ? "command" : "text"}`}
				/>
			</div>
		</div>
	);
}
