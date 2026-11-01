// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconChevronRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** Vertical list of large options (sign-in methods, flow choices). */
export function ChoiceList({
	children,
	label,
}: {
	children: ReactNode;
	/** Accessible name for the group. */
	label?: string;
}) {
	return (
		<ul aria-label={label} className="flex flex-col gap-2">
			{children}
		</ul>
	);
}

const itemClass =
	"group flex w-full cursor-pointer items-center gap-4 rounded-lg border px-4 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/** An option that navigates (`to`) or runs `onSelect`. */
export function ChoiceItem({
	title,
	description,
	to,
	onSelect,
	disabled,
	badge,
}: {
	title: ReactNode;
	description?: ReactNode;
	to?: string;
	onSelect?: () => void;
	disabled?: boolean;
	/** e.g. "Recommended" or "Last used". */
	badge?: ReactNode;
}) {
	const content = (
		<>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-center gap-2 text-sm font-medium">
					{title}
					{badge && (
						<span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
							{badge}
						</span>
					)}
				</span>
				{description && (
					<span className="text-xs text-muted-foreground">{description}</span>
				)}
			</span>
			<IconChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5" />
		</>
	);
	return (
		<li>
			{to && !disabled ? (
				<Link to={to} onClick={onSelect} className={itemClass}>
					{content}
				</Link>
			) : (
				<button
					type="button"
					disabled={disabled}
					onClick={onSelect}
					className={itemClass}
				>
					{content}
				</button>
			)}
		</li>
	);
}
