// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/* A fake Incus for data-layer tests: instances, state, projects, ETags and operations. */

export interface FakeInstance {
	status: string;
	config: Record<string, string>;
	devices: Record<string, Record<string, string>>;
	profiles: string[];
	description: string;
	memory: number;
}

export interface FakeProject {
	description: string;
	config: Record<string, string>;
}

export interface FakeOperation {
	id: string;
	status: string;
	project: string;
	may_cancel: boolean;
	resources: Record<string, string[]>;
}

export class FakeIncus {
	instances = new Map<string, FakeInstance>(); // "project/name"
	projects = new Map<string, FakeProject>();
	operations = new Map<string, FakeOperation>();
	requests: string[] = [];
	bodies: Array<{ method: string; url: string; body: unknown; ifMatch: string | null }> = [];
	/** When an operation is created, finish it immediately with this status (or leave Running). */
	finishOperationsAs: string | null = "Success";
	revision = 1;
	private opSeq = 0;

	add(project: string, name: string, extra: Partial<FakeInstance> = {}) {
		this.instances.set(`${project}/${name}`, {
			status: "Running",
			config: { "limits.cpu": "2" },
			devices: { root: { type: "disk", path: "/", pool: "default" } },
			profiles: ["default"],
			description: "",
			memory: 100,
			...extra,
		});
		if (!this.projects.has(project)) this.projects.set(project, { description: "", config: {} });
	}

	etag(key: string) {
		return `"${key}@${this.revision}"`;
	}

	private object(key: string) {
		const [project = "", name = ""] = key.split("/");
		const row = this.instances.get(key) as FakeInstance;
		return {
			name,
			project,
			status: row.status,
			status_code: row.status === "Running" ? 103 : 102,
			type: "container",
			location: "none",
			architecture: "x86_64",
			description: row.description,
			created_at: "",
			last_used_at: "",
			profiles: row.profiles,
			ephemeral: false,
			stateful: false,
			config: row.config,
			devices: row.devices,
			expanded_config: { ...row.config, "profile.applied": "yes" },
			expanded_devices: row.devices,
		};
	}

	private state(key: string) {
		const row = this.instances.get(key) as FakeInstance;
		return {
			status: row.status,
			status_code: row.status === "Running" ? 103 : 102,
			pid: 42,
			processes: 3,
			cpu: { usage: 1000 },
			memory: { usage: row.memory, usage_peak: row.memory, total: 1000 },
			disk: {},
			network: {},
		};
	}

	private operation(op: FakeOperation) {
		return {
			id: op.id,
			description: "Op",
			status: op.status,
			status_code: op.status === "Success" ? 200 : 103,
			resources: op.resources,
			may_cancel: op.may_cancel,
			err: "",
			created_at: "",
			updated_at: "",
			location: "none",
			project: op.project,
			metadata: null,
		};
	}

	startOperation(project: string, resources: Record<string, string[]>) {
		this.opSeq += 1;
		const op: FakeOperation = {
			id: `op${this.opSeq}`,
			status: this.finishOperationsAs ?? "Running",
			project,
			may_cancel: true,
			resources,
		};
		this.operations.set(op.id, op);
		return op;
	}

	fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
		const raw = String(input);
		const method = init?.method ?? "GET";
		const decoded = decodeURIComponent(raw.replaceAll("+", " "));
		this.requests.push(method === "GET" ? decoded : `${method} ${decoded}`);
		const headers = new Headers(init?.headers);
		if (method !== "GET") {
			this.bodies.push({
				method,
				url: decoded,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
				ifMatch: headers.get("If-Match"),
			});
		}
		const url = new URL(raw, "http://incus");
		const q = url.searchParams;
		const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
			new Response(JSON.stringify(body), { status, headers: extra });
		const sync = (metadata: unknown, extra: Record<string, string> = {}) =>
			reply(200, { type: "sync", status_code: 200, metadata }, extra);
		const accepted = (op: FakeOperation) =>
			reply(202, {
				type: "async",
				status_code: 100,
				operation: `/1.0/operations/${op.id}`,
				metadata: this.operation(op),
			});
		const notFound = () => reply(404, { type: "error", error_code: 404, error: "not found" });
		const path = url.pathname;

		if (path.startsWith("/1.0/operations/")) {
			const [id = "", wait] = path.slice("/1.0/operations/".length).split("/");
			const op = this.operations.get(id);
			if (!op) return notFound();
			if (method === "DELETE") {
				op.status = "Cancelled";
				return sync({});
			}
			if (wait === "wait" && op.status === "Running") op.status = this.finishOnWait;
			return sync(this.operation(op));
		}
		if (path === "/1.0/projects") {
			const names = [...this.projects.keys()];
			if (method === "POST") {
				const body = JSON.parse(String(init?.body));
				this.projects.set(body.name, { description: body.description ?? "", config: body.config ?? {} });
				return sync({});
			}
			if (q.get("recursion") === "1") return sync(names.map((n) => this.project(n)));
			return sync(names.map((n) => `/1.0/projects/${n}`));
		}
		if (path.startsWith("/1.0/projects/")) {
			const name = decodeURIComponent(path.slice("/1.0/projects/".length));
			const project = this.projects.get(name);
			if (!project) return notFound();
			if (method === "PUT") {
				if (headers.get("If-Match") !== this.etag(`project:${name}`)) {
					return reply(412, { type: "error", error_code: 412, error: "ETag doesn't match" });
				}
				Object.assign(project, JSON.parse(String(init?.body)));
				this.revision += 1;
				return sync({});
			}
			return sync(this.project(name), { ETag: this.etag(`project:${name}`) });
		}
		if (path === "/1.0/instances") {
			const project = q.get("project") ?? "default";
			const all = q.get("all-projects") === "true";
			const wanted = q.get("filter")?.match(/^status eq (\w+)$/)?.[1]?.toLowerCase();
			const keys = [...this.instances.keys()].filter((key) => {
				const [p] = key.split("/");
				const row = this.instances.get(key) as FakeInstance;
				return (all || p === project) && (!wanted || row.status.toLowerCase() === wanted);
			});
			if (q.get("recursion") === "2")
				return sync(keys.map((k) => ({ ...this.object(k), state: this.state(k) })));
			if (q.get("recursion") === "1") return sync(keys.map((k) => this.object(k)));
			return sync(
				keys.map((key) => {
					const [p = "", n = ""] = key.split("/");
					return `/1.0/instances/${n}${p === "default" ? "" : `?project=${p}`}`;
				}),
			);
		}
		const rest = decodeURIComponent(path.slice("/1.0/instances/".length));
		const [name = "", sub] = rest.split("/");
		const project = q.get("project") ?? "default";
		const key = `${project}/${name}`;
		const row = this.instances.get(key);
		if (!row) return notFound();
		const resources = { instances: [`/1.0/instances/${name}?project=${project}`] };
		if (sub === "state") {
			if (method === "PUT") {
				const { action } = JSON.parse(String(init?.body));
				if (this.finishOperationsAs === "Success")
					row.status = action === "stop" ? "Stopped" : "Running";
				return accepted(this.startOperation(project, resources));
			}
			return sync(this.state(key));
		}
		if (method === "PUT") {
			if (headers.get("If-Match") !== this.etag(key)) {
				return reply(412, { type: "error", error_code: 412, error: "ETag doesn't match" });
			}
			const body = JSON.parse(String(init?.body));
			Object.assign(row, { config: body.config, description: body.description });
			this.revision += 1;
			return accepted(this.startOperation(project, resources));
		}
		if (method === "DELETE") {
			this.instances.delete(key);
			return accepted(this.startOperation(project, resources));
		}
		return sync(this.object(key), { ETag: this.etag(key) });
	};

	/** Status a Running operation reaches when someone long-polls /wait. */
	finishOnWait = "Success";

	private project(name: string) {
		const p = this.projects.get(name) as FakeProject;
		const usedBy = [...this.instances.keys()]
			.filter((k) => k.startsWith(`${name}/`))
			.map((k) => `/1.0/instances/${k.slice(name.length + 1)}${name === "default" ? "" : `?project=${name}`}`);
		return { name, description: p.description, config: p.config, used_by: usedBy };
	}
}

export const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

export function mount<R>(watch: { subscribe(cb: () => void): () => void; getSnapshot(): R }, stops: Array<() => void>) {
	stops.push(watch.subscribe(() => undefined));
	return { get: () => watch.getSnapshot() };
}
