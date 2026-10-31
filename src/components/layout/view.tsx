// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { useProjects } from "@/hooks/incus/use-projects";
import {
	projectScope,
	projectScopeVersion,
	setProjectScope,
	subscribeProjectScope,
} from "@/lib/incus/project-scope";
import { Separator } from "../ui/separator";
import { SidebarTrigger } from "../ui/sidebar";
import { ProjectSelect } from "./project-select";

interface HeaderContextType {
	children: ReactNode;
	setChildren?: (children: ReactNode) => void;
}

const HeaderContext = createContext<HeaderContextType>({
	children: null,
	setChildren: undefined,
});

function ProjectHeaderSelect() {
	const projects = useProjects(["name"]);
	const version = useSyncExternalStore(
		subscribeProjectScope,
		projectScopeVersion,
		projectScopeVersion,
	);
	const names = projects.data?.map((project) => project.name) ?? [];
	return (
		<ProjectSelect
			projects={names}
			scope={version < 0 ? { kind: "all" } : projectScope()}
			onScope={setProjectScope}
		/>
	);
}

function RawHeader({ children }: { children: ReactNode }) {
	return (
		// FIXME: The clickability and positioning of the sidebar trigger is awful.
		<header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
			<div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
				<SidebarTrigger className="-ml-1" />
				<Separator orientation="vertical" className="mx-2 " />
				<div className="flex min-w-0 flex-1 items-center">{children}</div>
				<ProjectHeaderSelect />
			</div>
		</header>
	);
}

export function View({ children }: { children: ReactNode }) {
	const [headerChildren, setHeaderChildren] = useState<ReactNode>(null);
	return (
		<HeaderContext.Provider
			value={{ children: headerChildren, setChildren: setHeaderChildren }}
		>
			<RawHeader>{headerChildren}</RawHeader>
			<main>{children}</main>
		</HeaderContext.Provider>
	);
}

export default function Header({ children }: { children: ReactNode }) {
	const context = useContext(HeaderContext);
	useEffect(() => {
		context.setChildren?.(children);
		return () => context.setChildren?.(null);
	}, [children, context]);
	return null;
}
