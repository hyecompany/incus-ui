// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import type { JSX } from "react";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { ProjectScope } from "@/lib/incus/project-scope";

function optionValue(name: string): string {
	return `project:${encodeURIComponent(name)}`;
}

export function ProjectSelect(props: {
	projects: readonly string[];
	scope: ProjectScope;
	onScope: (scope: ProjectScope) => void;
}): JSX.Element {
	const { projects, scope, onScope } = props;

	const seen = new Set<string>();
	const optionNames: string[] = [];
	for (const project of projects) {
		const name = project.trim();
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		optionNames.push(name);
	}
	if (
		scope.kind === "project" &&
		scope.name.length > 0 &&
		!seen.has(scope.name)
	) {
		optionNames.push(scope.name);
	}

	const items = [
		{ label: "All projects", value: "all" },
		...optionNames.map((name) => ({
			label: name,
			value: optionValue(name),
		})),
	];
	const value = scope.kind === "all" ? "all" : optionValue(scope.name);

	return (
		<Select
			items={items}
			value={value}
			onValueChange={(selected) => {
				if (selected === "all") {
					onScope({ kind: "all" });
					return;
				}
				if (typeof selected !== "string" || !selected.startsWith("project:"))
					return;
				onScope({
					kind: "project",
					name: decodeURIComponent(selected.slice("project:".length)),
				});
			}}
		>
			<SelectTrigger aria-label="Project" className="w-44">
				<SelectValue />
			</SelectTrigger>
			<SelectContent align="end" alignItemWithTrigger={false}>
				<SelectGroup>
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	);
}
