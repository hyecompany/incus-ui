// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, useMemo, useState } from "react";
import { CommandBlock, Step, StepList } from "@/components/auth/shared";
import {
	browsersFor,
	IMPORT_BROWSER_LABELS,
	IMPORT_OS_LABELS,
	IMPORT_OSES,
	type ImportTarget,
	importGuide,
	pickBrowser,
} from "@/lib/incus/tls/browser-import";
import { cn } from "@/lib/ui/utils";

function Segmented<T extends string>({
	label,
	options,
	value,
	labels,
	onChange,
}: {
	label: string;
	options: readonly T[];
	value: T;
	labels: Record<T, string>;
	onChange: (value: T) => void;
}) {
	const name = useId();
	return (
		<fieldset className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
			<legend className="sr-only">{label}</legend>
			{options.map((option) => (
				<label
					key={option}
					className={cn(
						"cursor-pointer rounded-md px-3 py-1 text-sm transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
						option === value
							? "bg-background font-medium shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					<input
						type="radio"
						name={name}
						value={option}
						checked={option === value}
						onChange={() => onChange(option)}
						className="sr-only"
					/>
					{labels[option]}
				</label>
			))}
		</fieldset>
	);
}

/** Per-OS/browser steps for importing a .pfx; starts on `initial`, user-switchable. */
export function BrowserImportGuide({
	initial,
	pfxFile,
	siteUrl,
}: {
	initial: ImportTarget;
	/** Downloaded .pfx name; omit for the user's own certificate. */
	pfxFile?: string;
	siteUrl: string;
}) {
	const [target, setTarget] = useState(initial);
	const guide = useMemo(
		() => importGuide({ ...target, pfxFile, siteUrl }),
		[target, pfxFile, siteUrl],
	);
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-2">
				<Segmented
					label="Operating system"
					options={IMPORT_OSES}
					value={target.os}
					labels={IMPORT_OS_LABELS}
					onChange={(os) =>
						setTarget({ os, browser: pickBrowser(os, target.browser) })
					}
				/>
				<Segmented
					label="Browser"
					options={browsersFor(target.os)}
					value={target.browser}
					labels={IMPORT_BROWSER_LABELS}
					onChange={(browser) => setTarget({ ...target, browser })}
				/>
			</div>
			<StepList
				key={`${guide.os}-${guide.browser}`}
				className="motion-safe:animate-in motion-safe:fade-in-0"
			>
				{guide.steps.map((step) => (
					<Step key={step.title} title={step.title}>
						{step.detail && <span>{step.detail}</span>}
						{step.copy && (
							<CommandBlock
								command={step.copy.value}
								prompt={step.copy.kind === "command"}
							/>
						)}
					</Step>
				))}
			</StepList>
		</div>
	);
}
