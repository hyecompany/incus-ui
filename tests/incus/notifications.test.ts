// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncusEvent } from "../../src/lib/incus/events/types.ts";
import {
	noticeForLifecycle,
	noticeForOperation,
	operationProgress,
} from "../../src/lib/incus/notifications.ts";

const op = (metadata: Record<string, unknown>, extra: Partial<IncusEvent> = {}): IncusEvent => ({
	type: "operation",
	timestamp: "t",
	metadata: {
		id: "abc",
		description: "Starting instance",
		resources: { instances: ["/1.0/instances/web?project=prod"] },
		...metadata,
	},
	...extra,
});

const lc = (action: string, source: string, extra: Partial<IncusEvent> = {}): IncusEvent => ({
	type: "lifecycle",
	timestamp: "t1",
	metadata: { action, source },
	...extra,
});

describe("noticeForOperation", () => {
	it("keeps one id from running to success so the toast updates in place", () => {
		const running = noticeForOperation(op({ status: "Running" }, { project: "prod" }));
		const done = noticeForOperation(op({ status: "Success" }, { project: "prod" }));
		assert.equal(running?.id, "op:abc");
		assert.equal(done?.id, "op:abc");
		assert.equal(running?.tone, "loading");
		assert.equal(running?.title, "Starting instance: prod/web");
		assert.equal(running?.description, "Running · prod");
		assert.equal(done?.tone, "success");
	});

	it("shows progress, failure text and cancellation", () => {
		assert.equal(
			noticeForOperation(op({ status: "Running", metadata: { download_progress: "rootfs: 42%" } }))?.description,
			"rootfs: 42%",
		);
		const failed = noticeForOperation(op({ status: "Failure", err: "no space left" }));
		assert.deepEqual([failed?.tone, failed?.description], ["error", "no space left"]);
		assert.equal(noticeForOperation(op({ status: "Cancelled" }))?.tone, "info");
	});

	it("ignores unknown statuses, missing ids and other event types", () => {
		assert.equal(noticeForOperation(op({ status: "Weird" })), null);
		assert.equal(noticeForOperation(op({ id: undefined, status: "Running" })), null);
		assert.equal(noticeForOperation(lc("instance-started", "/1.0/instances/a")), null);
	});
});

describe("operationProgress", () => {
	it("reads *_progress strings and structured percent", () => {
		assert.equal(operationProgress({ metadata: { create_instance_from_image_unpack_progress: "Unpack: 80%" } }), "Unpack: 80%");
		assert.equal(operationProgress({ metadata: { progress: { stage: "copy", percent: "50" } } }), "copy: 50%");
		assert.equal(operationProgress({ metadata: null }), undefined);
	});
});

describe("noticeForLifecycle", () => {
	it("describes create, delete, rename and state changes", () => {
		assert.deepEqual(
			noticeForLifecycle(lc("instance-created", "/1.0/instances/web?project=prod", { project: "prod", location: "node1" })),
			{ id: "lc:instance-created:/1.0/instances/web:t1", tone: "success", title: "Instance created", description: "web in prod on node1" },
		);
		assert.equal(noticeForLifecycle(lc("instance-deleted", "/1.0/instances/web"))?.title, "Instance deleted");
		assert.equal(noticeForLifecycle(lc("instance-renamed", "/1.0/instances/web"))?.title, "Instance renamed");
		assert.equal(noticeForLifecycle(lc("instance-shutdown", "/1.0/instances/web"))?.title, "Instance shut down");
		assert.equal(
			noticeForLifecycle(lc("storage-volume-created", "/1.0/storage-pools/default/volumes/custom/v1"))?.description,
			"v1",
		);
		assert.equal(noticeForLifecycle(lc("instance-snapshot-created", "/1.0/instances/web/snapshots/s0"))?.title, "Snapshot created");
	});

	it("hides location 'none' and the default project", () => {
		assert.equal(
			noticeForLifecycle(lc("instance-started", "/1.0/instances/web", { project: "default", location: "none" }))?.description,
			"web",
		);
	});

	it("stays quiet for unknown or noisy actions", () => {
		assert.equal(noticeForLifecycle(lc("instance-log-retrieved", "/1.0/instances/web/logs/x")), null);
		assert.equal(noticeForLifecycle(lc("certificate-created", "/1.0/certificates/f")), null);
		assert.equal(noticeForLifecycle({ type: "logging", timestamp: "", metadata: {} }), null);
	});
});
