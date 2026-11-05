// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/ui/utils";

/** Bar widths cycled across cells, so placeholder rows do not look uniform. */
const WIDTHS = ["w-24", "w-16", "w-20", "w-14", "w-28", "w-12"];

/**
 * Skeletons fade in after a short delay: loads that finish quickly (cached or
 * prefetched data revalidating) never flash a placeholder.
 */
const DELAYED = "animate-in fade-in fill-mode-backwards delay-150 duration-300";

/** Placeholder lines for a list or menu while its items are unknown. */
export function SkeletonList({
	items = 3,
	className,
}: {
	items?: number;
	className?: string;
}) {
	return (
		<div
			aria-hidden
			data-slot="skeleton-list"
			className={cn("flex flex-col gap-2 px-2 py-1.5", DELAYED, className)}
		>
			{Array.from({ length: items }, (_, item) => (
				<Skeleton
					// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
					key={item}
					className={cn("h-4", WIDTHS[item % WIDTHS.length])}
				/>
			))}
		</div>
	);
}

/** Screen-reader announcement to pair with aria-hidden skeletons. */
export function LoadingStatus({ label = "Loading" }: { label?: string }) {
	return <output className="sr-only">{label}</output>;
}
