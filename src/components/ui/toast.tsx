// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) 2023 shadcn

"use client";

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import {
	IconAlertCircle,
	IconAlertTriangle,
	IconCircleCheck,
	IconInfoCircle,
	IconLoader2,
	IconX,
} from "@tabler/icons-react";
import { cn } from "cn";
import type * as React from "react";

export type ToastTone = "loading" | "success" | "error" | "info" | "warning";

/**
 * Global toast manager. Usable outside React components; the provider below
 * hands it to Base UI so `toastManager.add()` shows toasts in the viewport.
 */
const toastManager = ToastPrimitive.createToastManager();

function ToastProvider({
	children,
	timeout = 4000,
	limit = 5,
}: {
	children?: React.ReactNode;
	timeout?: number;
	limit?: number;
}) {
	return (
		<ToastPrimitive.Provider
			toastManager={toastManager}
			timeout={timeout}
			limit={limit}
		>
			{children}
		</ToastPrimitive.Provider>
	);
}

const toneStyles: Record<
	ToastTone,
	{ root: string; icon: string; Icon: typeof IconInfoCircle }
> = {
	loading: {
		root: "border-l-sky-500",
		icon: "text-sky-500",
		Icon: IconLoader2,
	},
	success: {
		root: "border-l-emerald-500",
		icon: "text-emerald-500",
		Icon: IconCircleCheck,
	},
	error: {
		root: "border-l-destructive",
		icon: "text-destructive",
		Icon: IconAlertCircle,
	},
	info: {
		root: "border-l-sky-400",
		icon: "text-sky-400",
		Icon: IconInfoCircle,
	},
	warning: {
		root: "border-l-amber-500",
		icon: "text-amber-500",
		Icon: IconAlertTriangle,
	},
};

// Stacking uses the CSS variables Base UI sets on each toast: the newest
// toast sits at the bottom, older ones peek out above and scale down.
const toastRootClass =
	"absolute right-0 bottom-0 w-full rounded-lg border border-l-4 bg-popover text-popover-foreground shadow-lg outline-none select-none transition-[transform,opacity] duration-300 ease-out [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)_-_var(--toast-index)_*_0.5rem))_scale(calc(1_-_var(--toast-index)_*_0.05))] data-[expanded]:[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)_-_var(--toast-offset-y)_-_var(--toast-index)_*_0.5rem))] data-[limited]:hidden data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 z-[calc(1000_-_var(--toast-index))]";

function Toaster() {
	const { toasts } = ToastPrimitive.useToastManager();

	return (
		<ToastPrimitive.Portal>
			<ToastPrimitive.Viewport
				data-slot="toast-viewport"
				className="fixed right-4 bottom-4 z-50 h-(--toast-frontmost-height) w-[min(22rem,calc(100vw_-_2rem))]"
			>
				{toasts.map((toast) => {
					const tone = (toast.type ?? "info") as ToastTone;
					const style = toneStyles[tone] ?? toneStyles.info;
					const { Icon } = style;
					return (
						<ToastPrimitive.Root
							key={toast.id}
							toast={toast}
							data-slot="toast"
							data-tone={tone}
							className={cn(toastRootClass, style.root)}
						>
							<ToastPrimitive.Content className="flex items-start gap-3 p-3 pr-8">
								<Icon
									aria-hidden="true"
									className={cn(
										"mt-0.5 size-4 shrink-0",
										style.icon,
										tone === "loading" && "animate-spin",
									)}
								/>
								<div className="grid min-w-0 flex-1 gap-0.5">
									<ToastPrimitive.Title className="text-sm font-medium leading-snug" />
									<ToastPrimitive.Description className="text-xs text-muted-foreground break-words" />
								</div>
							</ToastPrimitive.Content>
							<ToastPrimitive.Close
								aria-label="Dismiss notification"
								className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							>
								<IconX aria-hidden="true" className="size-3.5" />
							</ToastPrimitive.Close>
						</ToastPrimitive.Root>
					);
				})}
			</ToastPrimitive.Viewport>
		</ToastPrimitive.Portal>
	);
}

export { Toaster, ToastProvider, toastManager };
