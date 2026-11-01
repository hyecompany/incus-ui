// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "./copy";

/** Icon button that copies `value`; shows a check mark briefly on success. */
export function CopyButton({
	value,
	label = "Copy",
	className,
}: {
	value: string;
	/** Accessible name, e.g. "Copy command". */
	label?: string;
	className?: string;
}) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	useEffect(() => {
		if (state === "idle") return;
		const timer = setTimeout(() => setState("idle"), 2_000);
		return () => clearTimeout(timer);
	}, [state]);
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			className={className}
			aria-label={label}
			title={
				state === "failed" ? "Copy failed: select and copy manually" : label
			}
			onClick={async () =>
				setState((await copyText(value)) ? "copied" : "failed")
			}
		>
			{state === "copied" ? (
				<IconCheck className="text-emerald-500" />
			) : (
				<IconCopy />
			)}
			<span className="sr-only" aria-live="polite">
				{state === "copied"
					? "Copied"
					: state === "failed"
						? "Copy failed"
						: ""}
			</span>
		</Button>
	);
}
