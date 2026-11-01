// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { CopyButton } from "@/components/auth/shared";

/** A secret shown once (e.g. the .pfx password) with a copy button. */
export function SecretValue({
	label,
	value,
}: {
	label: string;
	value: string;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<p className="text-xs text-muted-foreground">{label}</p>
			<div className="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3">
				<code className="min-w-0 flex-1 font-mono text-sm tracking-wide break-all select-all">
					{value}
				</code>
				<CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
			</div>
		</div>
	);
}
