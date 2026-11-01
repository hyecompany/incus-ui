// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-License-Identifier: Apache-2.0

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { ProjectSelector } from "../navigation/project-selector";
import { Separator } from "../ui/separator";
import { SidebarTrigger } from "../ui/sidebar";

interface HeaderContextType {
	children: ReactNode;
	setChildren?: (children: ReactNode) => void;
}

const HeaderContext = createContext<HeaderContextType>({
	children: null,
	setChildren: undefined,
});

function RawHeader({ children }: { children: ReactNode }) {
	return (
		// FIXME: The clickability and positioning of the sidebar trigger is awful.
		<header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
			<div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
				<SidebarTrigger className="-ml-1" />
				<Separator orientation="vertical" className="mx-2 " />
				{children}
				<ProjectSelector className="ml-auto" />
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
