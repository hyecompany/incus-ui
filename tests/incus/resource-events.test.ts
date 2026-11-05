// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncusEvent } from "../../src/lib/incus/events/types.ts";
import { parseResourceChange } from "../../src/lib/incus/resource-events.ts";

function lifecycle(action: string, source: string, extra: Partial<IncusEvent> = {}): IncusEvent {
	return {
		type: "lifecycle",
		timestamp: "2026-11-01T00:00:00Z",
		metadata: { action, source, requestor: { username: "u" } },
		...extra,
	};
}

describe("parseResourceChange", () => {
	it("reads create, delete, update and rename of an instance", () => {
		for (const verb of ["created", "deleted", "updated", "renamed"]) {
			const change = parseResourceChange(
				lifecycle(`instance-${verb}`, "/1.0/instances/c1?project=web", { project: "web", location: "node1" }),
			);
			assert.deepEqual(change, {
				action: `instance-${verb}`,
				verb,
				collection: "instances",
				path: "/1.0/instances/c1",
				name: "c1",
				project: "web",
				location: "node1",
			});
		}
	});

	it("uses the top-level collection for nested resources", () => {
		const change = parseResourceChange(
			lifecycle("storage-volume-created", "/1.0/storage-pools/default/volumes/custom/v1"),
		);
		assert.equal(change?.collection, "storage-pools");
		assert.equal(change?.name, "default");
		assert.equal(change?.verb, "created");
	});

	it("decodes names and handles collection-only sources", () => {
		assert.equal(parseResourceChange(lifecycle("image-created", "/1.0/images/a%20b"))?.name, "a b");
		const change = parseResourceChange(lifecycle("config-updated", "/1.0/"));
		assert.equal(change, null);
		assert.equal(parseResourceChange(lifecycle("network-acl-updated", "/1.0/network-acls"))?.name, undefined);
	});

	it("never invents project or location", () => {
		const change = parseResourceChange(lifecycle("instance-created", "/1.0/instances/c1?project=web"));
		assert.equal(change?.project, undefined);
		assert.equal(change?.location, undefined);
	});

	it("ignores non-lifecycle events and unusable metadata", () => {
		assert.equal(parseResourceChange({ type: "operation", timestamp: "", metadata: { action: "x", source: "/1.0/x" } }), null);
		assert.equal(parseResourceChange({ type: "lifecycle", timestamp: "", metadata: null }), null);
		assert.equal(parseResourceChange(lifecycle("instance-created", "https://evil/1.0/instances/c1")), null);
		assert.equal(parseResourceChange({ type: "lifecycle", timestamp: "", metadata: { action: "instance-created" } }), null);
	});
});
