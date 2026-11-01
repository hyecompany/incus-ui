// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { IconArrowLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/ui/utils";

/** One sign-in screen. The auth layout centres it on the page. */
export function AuthCard({
	title,
	description,
	back,
	footer,
	wide = false,
	children,
	className,
}: {
	title: ReactNode;
	/** What this screen is for and what happens next. */
	description?: ReactNode;
	/** Usually an `<AuthBackLink>`, shown above the title. */
	back?: ReactNode;
	/** Small print under the body, e.g. `<AnotherMethodLink />`. */
	footer?: ReactNode;
	/** Wider card for multi-column instructions. */
	wide?: boolean;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"flex w-full flex-col gap-6 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 sm:p-8",
				wide ? "max-w-3xl" : "max-w-lg",
				className,
			)}
		>
			<header className="flex flex-col gap-2">
				{back}
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{description && (
					<div className="text-sm text-muted-foreground">{description}</div>
				)}
			</header>
			{children && <div className="flex flex-col gap-5">{children}</div>}
			{footer && (
				<footer className="flex flex-col items-center gap-2 border-t pt-4 text-center text-xs text-muted-foreground">
					{footer}
				</footer>
			)}
		</section>
	);
}

/** "← Back" link for the top of an `AuthCard`. */
export function AuthBackLink({
	to,
	search,
	children = "Back",
	onClick,
}: {
	to: string;
	search?: Record<string, string | boolean>;
	children?: ReactNode;
	onClick?: () => void;
}) {
	return (
		<Link
			to={to}
			search={search}
			onClick={onClick}
			className="-ml-1 inline-flex w-fit items-center gap-1 rounded-md px-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
		>
			<IconArrowLeft className="size-4" />
			{children}
		</Link>
	);
}
