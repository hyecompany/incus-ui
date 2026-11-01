// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-License-Identifier: Apache-2.0

import { Menu } from "@base-ui/react/menu";
import {
	IconArrowsHorizontal,
	IconBucket,
	IconChevronRight,
	IconCube3dSphere,
	IconDatabase,
	IconDisc,
	IconRectangularPrism,
	IconSelectAll,
	IconServer,
	IconSquaresSelected,
} from "@tabler/icons-react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { UserMenu } from "@/components/auth/user-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	useSidebar,
} from "@/components/ui/sidebar";

type NavigationItem = {
	title: string;
	route: string;
	icon: typeof IconSelectAll;
	subItems?: { title: string; route: string; icon: typeof IconSelectAll }[];
};

const navItems = {
	primary: [
		{
			title: "Instances",
			route: "/instances",
			icon: IconSelectAll,
		},
		{
			title: "Networks",
			route: "/networks",
			icon: IconArrowsHorizontal,
		},
		{
			title: "Storage Pools",
			route: "/storage-pools",
			icon: IconDatabase,
			subItems: [
				{
					title: "Volumes",
					route: "/storage/volumes",
					icon: IconRectangularPrism,
				},
				{ title: "Buckets", route: "/storage/buckets", icon: IconBucket },
				{ title: "ISOs", route: "/storage/isos", icon: IconDisc },
			],
		},
		{
			title: "Images",
			route: "/images",
			icon: IconCube3dSphere,
		},
		{
			title: "Profiles",
			route: "/profiles",
			icon: IconSquaresSelected,
		},
		// TODO: Display when clustered (#5)
		/*
		{
			title: "Servers",
			route: "/servers",
			icon: IconServer,
		},
        */
	],
	// TODO: Change to "Cluster" with IconHexagons when clustered (#5)
	secondary: [{ title: "Server", route: "/settings", icon: IconServer }],
};

function setPressOrigin(surface: HTMLElement, x: number, y: number) {
	surface.style.setProperty("--press-x", `${x}px`);
	surface.style.setProperty("--press-y", `${y}px`);
	for (const visual of surface.querySelectorAll<HTMLElement>(
		"[data-press-visual]",
	)) {
		let offsetX = 0;
		let offsetY = 0;
		let element: HTMLElement | null = visual;
		while (element && element !== surface) {
			offsetX += element.offsetLeft;
			offsetY += element.offsetTop;
			element = element.offsetParent as HTMLElement | null;
		}
		visual.style.setProperty("--press-x", `${x - offsetX}px`);
		visual.style.setProperty("--press-y", `${y - offsetY}px`);
	}
}

function CollapsedMenuTrigger({
	route,
	onNavigate,
	...props
}: Menu.Trigger.Props & { route?: string; onNavigate: () => void }) {
	const input = useRef("mouse");
	return (
		<Menu.Trigger
			{...props}
			openOnHover
			closeDelay={120}
			nativeButton={!route}
			render={route ? <Link to={route} /> : undefined}
			onPointerDown={(event) => {
				input.current = event.pointerType;
			}}
			onMouseDown={(event) => {
				if (route && input.current === "mouse") event.preventBaseUIHandler();
			}}
			onKeyDown={(event) => {
				input.current =
					event.key === " " || event.key.startsWith("Arrow")
						? "keyboard-menu"
						: "keyboard-navigation";
				if (route && event.key === "Enter") event.preventBaseUIHandler();
			}}
			onClick={(event) => {
				const pointerType =
					(event.nativeEvent as PointerEvent).pointerType || input.current;
				if (
					pointerType === "touch" ||
					pointerType === "pen" ||
					pointerType === "keyboard-menu"
				) {
					// Let the menu handle the activation without following the link.
					event.preventDefault();
				} else if (route) {
					event.preventBaseUIHandler();
					onNavigate();
				}
			}}
		/>
	);
}

function SidebarNavigation({
	items,
	allowSubItems = true,
}: {
	items: NavigationItem[];
	allowSubItems?: boolean;
}) {
	const matchRoute = useMatchRoute();
	const { state, isMobile, setOpenMobile } = useSidebar();
	const isIconCollapsed = !isMobile && state === "collapsed";
	const [menuElement, setMenuElement] = useState<HTMLUListElement | null>(null);
	const [openFlyout, setOpenFlyout] = useState<string | null>(null);
	const [openItems, setOpenItems] = useState<Record<string, boolean>>({
		"/instances": true,
	});
	const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	function cancelHoverOpen() {
		if (hoverOpenTimer.current !== null) {
			clearTimeout(hoverOpenTimer.current);
			hoverOpenTimer.current = null;
		}
	}
	useLayoutEffect(() => {
		if (!isIconCollapsed) setOpenFlyout(null);
	}, [isIconCollapsed]);
	useLayoutEffect(() => {
		if (isIconCollapsed) return;
		const rows = menuElement?.querySelectorAll<HTMLElement>(
			"[data-adaptive-disclosure]",
		);
		if (!rows) return;

		const updateTarget = (row: HTMLElement) => {
			const label = row.querySelector<HTMLElement>("[data-nav-label]");
			if (!label) return;
			const bounds = row.getBoundingClientRect();
			const labelEnd = label.getBoundingClientRect().right - bounds.left;
			// Protect the label plus 12px; split the remaining gap before the glyph.
			const protectedEnd = labelEnd + 12;
			const glyphStart = bounds.width - 28;
			const boundary =
				protectedEnd + Math.max(0, glyphStart - protectedEnd) / 2;
			const width = Math.min(
				bounds.width,
				Math.max(40, bounds.width - boundary),
			);
			row.style.setProperty("--disclosure-width", `${width}px`);
		};
		const observer = new ResizeObserver(() => rows.forEach(updateTarget));
		for (const row of rows) {
			updateTarget(row);
			observer.observe(row);
			const label = row.querySelector<HTMLElement>("[data-nav-label]");
			if (label) observer.observe(label);
		}
		return () => {
			observer.disconnect();
			if (hoverOpenTimer.current !== null) {
				clearTimeout(hoverOpenTimer.current);
				hoverOpenTimer.current = null;
			}
		};
	}, [isIconCollapsed, menuElement]);

	return (
		<SidebarMenu
			ref={setMenuElement}
			onPointerDownCapture={(event) => {
				const surface = (event.target as Element).closest<HTMLElement>(
					".nav-surface",
				);
				if (!surface) return;
				const bounds = surface.getBoundingClientRect();
				const x = Math.max(
					0,
					Math.min(bounds.width, event.clientX - bounds.left),
				);
				const y = Math.max(
					0,
					Math.min(bounds.height, event.clientY - bounds.top),
				);
				// Anchor the opposite edge so the pressed side moves inward.
				setPressOrigin(surface, bounds.width - x, bounds.height - y);
			}}
			onKeyDownCapture={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				const surface = (event.target as Element).closest<HTMLElement>(
					".nav-surface",
				);
				if (!surface) return;
				setPressOrigin(
					surface,
					surface.clientWidth / 2,
					surface.clientHeight / 2,
				);
			}}
			className="gap-1 transition-[gap] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[collapsible=icon]:gap-2"
		>
			{items.map((item) => (
				<Menu.Root
					key={item.route}
					open={isIconCollapsed && openFlyout === item.route}
					onOpenChange={(open) => setOpenFlyout(open ? item.route : null)}
				>
					<SidebarMenuItem>
						<div
							data-adaptive-disclosure={
								allowSubItems && item.subItems ? "" : undefined
							}
							data-active={!!matchRoute({ to: item.route, fuzzy: false })}
							className="nav-surface relative isolate flex h-10 items-center gap-1 overflow-hidden rounded-lg transition-[width,height] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:gap-0"
						>
							<SidebarMenuButton
								className="relative h-10 min-w-0 flex-1 cursor-pointer justify-start gap-3 rounded-lg p-0 text-[15px] font-medium text-sidebar-foreground/90 transition-[width,height,padding,gap] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-transparent hover:text-sidebar-foreground/90 active:bg-transparent active:text-sidebar-foreground/90 data-active:bg-transparent data-active:text-sidebar-foreground/90 [&_svg]:size-5 group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0!"
								isActive={!!matchRoute({ to: item.route, fuzzy: false })}
								render={
									isIconCollapsed && allowSubItems && item.subItems ? (
										<CollapsedMenuTrigger
											route={item.route}
											onNavigate={() => setOpenFlyout(null)}
										/>
									) : (
										<Link
											to={item.route}
											onClick={() => {
												if (isMobile) setOpenMobile(false);
											}}
										/>
									)
								}
								tooltip={
									isIconCollapsed && allowSubItems && item.subItems
										? undefined
										: item.title
								}
							>
								<span
									data-press-visual
									className="flex size-10 shrink-0 items-center justify-center transition-[width,height] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[collapsible=icon]:size-8"
								>
									<item.icon />
								</span>
								<span
									data-nav-label
									data-press-visual
									className="shrink-0 transition-opacity duration-180 ease-out group-data-[collapsible=icon]:opacity-0"
								>
									{item.title}
								</span>
							</SidebarMenuButton>
							{allowSubItems && item.subItems && (
								<button
									type="button"
									className="relative flex h-10 w-(--disclosure-width) shrink-0 cursor-pointer items-center justify-end rounded-lg pr-3 text-sidebar-foreground/55 transition-[background-color] duration-120 hover:bg-sidebar-foreground/0.5 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-sidebar-ring group-data-[collapsible=icon]:hidden"
									aria-label={`${openItems[item.route] ? "Collapse" : "Expand"} ${item.title}`}
									aria-expanded={!!openItems[item.route]}
									aria-controls={`${item.title}-subitems`}
									onPointerEnter={(event) => {
										cancelHoverOpen();
										if (
											event.pointerType !== "mouse" ||
											isMobile ||
											openItems[item.route]
										)
											return;
										hoverOpenTimer.current = setTimeout(() => {
											hoverOpenTimer.current = null;
											setOpenItems((current) => ({
												...current,
												[item.route]: true,
											}));
										}, 700);
									}}
									onPointerLeave={cancelHoverOpen}
									onPointerDown={cancelHoverOpen}
									onPointerCancel={cancelHoverOpen}
									onClick={() => {
										cancelHoverOpen();
										setOpenItems((current) => ({
											...current,
											[item.route]: !current[item.route],
										}));
									}}
								>
									<span data-press-visual className="flex">
										<IconChevronRight
											className={`size-4 transition-[rotate] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${openItems[item.route] ? "rotate-90" : "rotate-0"}`}
										/>
									</span>
								</button>
							)}
						</div>
						{allowSubItems && item.subItems && (
							<div
								id={`${item.title}-subitems`}
								aria-hidden={!openItems[item.route] || isIconCollapsed}
								inert={!openItems[item.route] || isIconCollapsed}
								className={`grid transition-[grid-template-rows,opacity] duration-180 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${openItems[item.route] && !isIconCollapsed ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
							>
								<div className="min-h-0 overflow-hidden">
									<SidebarMenuSub className="mx-0 translate-x-0 gap-1 border-0 p-0 pt-1 pb-2 pl-7 group-data-[collapsible=icon]:flex">
										{item.subItems.map((subItem) => (
											<SidebarMenuSubItem key={subItem.route}>
												<SidebarMenuSubButton
													isActive={
														!!matchRoute({
															to: subItem.route,
															fuzzy: false,
														})
													}
													className="nav-surface relative isolate h-9 translate-x-0 gap-2.5 px-3 font-normal text-sidebar-foreground/80 transition-[background-color] duration-120 hover:bg-transparent hover:text-sidebar-foreground/80 active:bg-transparent active:text-sidebar-foreground/80 data-active:bg-transparent data-active:font-normal data-active:text-sidebar-foreground/80 group-data-[collapsible=icon]:flex [&>svg]:text-current [&>span:last-child]:text-clip"
													render={
														<Link
															to={subItem.route}
															onClick={() => {
																if (isMobile) setOpenMobile(false);
															}}
														/>
													}
												>
													<span
														data-press-visual
														aria-hidden="true"
														className="flex size-4 shrink-0 [&>svg]:size-4"
													>
														<subItem.icon />
													</span>
													<span data-press-visual className="shrink-0">
														{subItem.title}
													</span>
												</SidebarMenuSubButton>
											</SidebarMenuSubItem>
										))}
									</SidebarMenuSub>
								</div>
							</div>
						)}
					</SidebarMenuItem>
					{allowSubItems && item.subItems && (
						<Menu.Portal>
							<Menu.Positioner
								side="right"
								align="start"
								sideOffset={12}
								className="z-50"
							>
								<Menu.Popup className="min-w-52 rounded-xl border border-sidebar-border bg-sidebar p-1.5 text-sidebar-foreground shadow-xl outline-none transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
									<Menu.Item
										render={<Link to={item.route} />}
										className="flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none data-highlighted:bg-sidebar-foreground/5"
									>
										<item.icon className="size-5" />
										{item.title}
									</Menu.Item>
									<Menu.Separator className="my-1 h-px bg-sidebar-border" />
									{item.subItems.map((subItem) => (
										<Menu.Item
											key={subItem.route}
											render={<Link to={subItem.route} />}
											className="mt-1 flex h-9 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm text-sidebar-foreground/80 outline-none data-highlighted:bg-sidebar-foreground/5"
										>
											<subItem.icon className="size-4 shrink-0" />
											{subItem.title}
										</Menu.Item>
									))}
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					)}
				</Menu.Root>
			))}
		</SidebarMenu>
	);
}

export function UiSidebar() {
	return (
		<Sidebar collapsible="icon" variant="inset">
			<SidebarHeader>
				<div className="flex w-full">
					<img
						src="https://linuxcontainers.org/static/img/containers.svg"
						alt="Linux Containers logo"
						className="group-data-[collapsible=icon]:w-8 w-10 shrink-0 transition-all duration-220 ease-[cubic-bezier(0.22,1,0.36,1)]"
					/>
					<p className="group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:ml-0 max-w-40 overflow-hidden opacity-100 transition-all duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] my-auto ml-3 text-xl font-semibold whitespace-nowrap">
						Incus UI
					</p>
				</div>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarNavigation items={navItems.primary} />
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter className="p-0">
				<SidebarGroup>
					<SidebarNavigation items={navItems.secondary} allowSubItems={false} />
					<SidebarMenu className="mt-1">
						<UserMenu />
					</SidebarMenu>
				</SidebarGroup>
			</SidebarFooter>
		</Sidebar>
	);
}
