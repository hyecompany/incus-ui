// SPDX-FileCopyrightText: © 2026 William Walters <me@luxxy.xyz>
// SPDX-License-Identifier: Apache-2.0

import {
	ALL_PROJECTS,
	collectionMemberIdentity,
	type InstanceField,
	type InstanceQuery,
	instanceCollectionRequest,
	instanceRepresentation,
} from "./instances.ts";
import { instancePath } from "./internal/paths.ts";
import type { IncusStore } from "./store.ts";

export type PlanReason = "incomplete" | "stale" | "fields";

export type InstanceCollectionPlan = {
	path: string;
	project: string;
	representation: 0 | 1;
	reason: PlanReason;
};

const STATUS_FILTER_METACHARACTERS = new Set<string>([
	".",
	"*",
	"+",
	"?",
	"^",
	"$",
	"\\",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	"|",
]);

function isLiteralStatusFilter(value: string): boolean {
	for (const character of value) {
		if (STATUS_FILTER_METACHARACTERS.has(character)) return false;
	}
	return true;
}

function statusEquals(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function collectionSatisfies(
	store: IncusStore,
	project: string,
	status: string | null,
	fields: readonly InstanceField[],
): boolean {
	const collection = store.getCollection(project, status);
	if (!collection.complete || !collection.fresh) return false;
	if (instanceRepresentation(fields) === 0) return true;
	for (const stored of collection.names) {
		const identity = collectionMemberIdentity(project, stored);
		const instance = store.getInstance(identity.project, identity.name);
		if (!instance) return false;
		for (const field of fields) {
			const observation = instance.fields[field];
			if (!observation?.fresh) return false;
		}
	}
	return true;
}

function materializeStatusFilter(
	store: IncusStore,
	project: string,
	status: string,
): boolean {
	if (!isLiteralStatusFilter(status)) return false;
	const source = store.getCollection(project, null);
	if (!source.complete || !source.fresh) return false;
	const matched: string[] = [];
	for (const stored of source.names) {
		const identity = collectionMemberIdentity(project, stored);
		const observed = store.getInstance(identity.project, identity.name)?.fields
			.status;
		if (!observed?.fresh) return false;
		if (statusEquals(observed.value, status)) matched.push(stored);
	}
	const token =
		project === ALL_PROJECTS
			? store.beginReadAll()
			: store.beginRead(project, matched);
	return store.applyCollection(token, {
		project,
		status,
		representation: 0,
		entries: matched.map((stored) => {
			const identity = collectionMemberIdentity(project, stored);
			return instancePath(identity.project, identity.name);
		}),
	});
}

function planReason(
	store: IncusStore,
	project: string,
	status: string | null,
): PlanReason {
	const collection = store.getCollection(project, status);
	if (!collection.complete) return "incomplete";
	if (!collection.fresh) return "stale";
	return "fields";
}

export function planInstanceCollection(
	store: IncusStore,
	fields: readonly InstanceField[],
	query: InstanceQuery = {},
): InstanceCollectionPlan | null {
	const request = instanceCollectionRequest(fields, query);
	const project = request.project;
	const status = query.status ? query.status : null;
	if (collectionSatisfies(store, project, status, fields)) return null;
	if (
		status !== null &&
		materializeStatusFilter(store, project, status) &&
		collectionSatisfies(store, project, status, fields)
	) {
		return null;
	}
	return {
		path: request.path,
		project,
		representation: request.representation,
		reason: planReason(store, project, status),
	};
}
