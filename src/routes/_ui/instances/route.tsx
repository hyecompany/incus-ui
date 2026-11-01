// SPDX-FileCopyrightText: © 2026 Joseph Maldjian <joseph.maldjian@hyecompany.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { EventsDebugPanel } from "@/components/debug/events-debug-panel";
import { InstanceList } from "@/components/instances/instance-list";
import Header from "@/components/layout/view";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
} from "@/components/ui/breadcrumb";

export const Route = createFileRoute("/_ui/instances")({
	component: RouteComponent,
});

function RouteComponent() {
	return (
		<>
			<Header>
				<Breadcrumb>
					<BreadcrumbList>
						<BreadcrumbItem>
							<BreadcrumbLink>Instances</BreadcrumbLink>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
			</Header>
			<InstanceList />
			<EventsDebugPanel />
		</>
	);
}
