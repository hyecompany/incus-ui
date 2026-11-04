// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { LoadingStatus, SkeletonList } from "@/components/loading/skeletons";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useProjectScope } from "@/hooks/incus/use-project-scope";
import { useProjects, useProjectsApi } from "@/hooks/incus/use-projects";
import { collectionView } from "@/lib/incus/data/loading";
import {
	ALL_PROJECTS,
	type ProjectScope,
	projectScopeKey,
	scopeFromKey,
} from "@/lib/incus/project-scope";
import { cn } from "@/lib/ui/utils";

const ERROR_KEY = "status:error";
const EMPTY_KEY = "status:empty";

function scopeLabel(scope: ProjectScope, isAvailable: boolean): string {
	if (scope.kind === "all") {
		return "All Projects";
	}
	return isAvailable ? scope.name : `${scope.name} (unavailable)`;
}

export function ProjectSelector({ className }: { className?: string }) {
	const { scope, setScope, isAvailable } = useProjectScope();
	// Names only: one small URL-list request, then kept live by events.
	const projects = useProjects(["name"]);
	const api = useProjectsApi();
	const names = projects.data ?? [];
	const error = projects.error;
	const view = collectionView(projects);

	const selectedKey = projectScopeKey(scope);

	return (
		<div className={cn("flex min-w-0 items-center gap-1", className)}>
			<Select
				value={selectedKey}
				onValueChange={(key) => {
					const next = key === null ? null : scopeFromKey(key);
					if (next !== null) {
						setScope(next);
					}
				}}
			>
				<SelectTrigger aria-label="Project" className="max-w-36 sm:max-w-56">
					<SelectValue>{scopeLabel(scope, isAvailable)}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={projectScopeKey(ALL_PROJECTS)}>
						All Projects
					</SelectItem>
					{view.kind === "skeleton" && (
						<>
							<LoadingStatus label="Loading projects" />
							<SkeletonList items={3} />
						</>
					)}
					{error !== null && (
						<SelectItem value={ERROR_KEY} disabled>
							Could not load projects
						</SelectItem>
					)}
					{view.kind === "empty" && (
						<SelectItem value={EMPTY_KEY} disabled>
							No projects
						</SelectItem>
					)}
					{names.map((project) => (
						<SelectItem
							key={project.name}
							value={projectScopeKey({ kind: "project", name: project.name })}
						>
							{project.name}
						</SelectItem>
					))}
					{!isAvailable && scope.kind === "project" && (
						<SelectItem value={selectedKey} disabled>
							{scopeLabel(scope, false)}
						</SelectItem>
					)}
				</SelectContent>
			</Select>
			{error !== null && (
				<button
					type="button"
					className="shrink-0 rounded-md px-1.5 py-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
					onClick={() => api?.refreshList(["name"])}
				>
					Retry
				</button>
			)}
		</div>
	);
}
