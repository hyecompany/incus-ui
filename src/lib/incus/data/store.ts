// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/** When and under which event coverage a fact was established. */
export interface Validation {
	at: number;
	epoch: number | null;
}

/** Fields that one representation returns and invalidates together. */
export interface FieldGroup {
	values: Readonly<Record<string, unknown>>;
	validation: Validation;
	/** An event said these values changed; they need validation. */
	invalid: boolean;
}

/** Everything known about one resource identity. */
export interface ResourceRecord {
	key: string;
	lifecycle: number;
	/** true: exists. false: known absent. undefined: unknown. */
	exists: boolean | undefined;
	existence?: Validation;
	groups: ReadonlyMap<string, FieldGroup>;
}

/** Membership of one Incus API collection query, separate from fields. */
export interface CollectionRecord {
	key: string;
	members: ReadonlySet<string>;
	/** Every member is known (the response established full membership). */
	complete: boolean;
	/** Possible members whose membership cannot be decided yet. */
	unresolved: ReadonlySet<string>;
	validation?: Validation;
	invalid: boolean;
}

type Listener = (changed: ReadonlySet<string>) => void;

/** Shared in-memory state. */
export class ObservationStore {
	private readonly records = new Map<string, ResourceRecord>();
	private readonly collections = new Map<string, CollectionRecord>();
	private readonly listeners = new Set<Listener>();
	private changed: Set<string> | null = null;

	record(key: string): ResourceRecord | undefined {
		return this.records.get(key);
	}

	/** Records whose key starts with `prefix` (one resource type). */
	recordsWithPrefix(prefix: string): ResourceRecord[] {
		return [...this.records.values()].filter((r) => r.key.startsWith(prefix));
	}

	collection(key: string): CollectionRecord | undefined {
		return this.collections.get(key);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	batch<T>(work: () => T): T {
		if (this.changed) {
			return work();
		}
		this.changed = new Set();
		try {
			return work();
		} finally {
			const changed = this.changed;
			this.changed = null;
			if (changed.size > 0) {
				for (const listener of [...this.listeners]) listener(changed);
			}
		}
	}

	/** Records that the resource exists, starting a new lifecycle if it was not. */
	markExists(key: string, validation: Validation): void {
		const current = this.records.get(key);
		if (current?.exists === true) {
			this.put({ ...current, existence: validation });
			return;
		}
		this.put({
			key,
			lifecycle: (current?.lifecycle ?? 0) + (current ? 1 : 0),
			exists: true,
			existence: validation,
			groups: new Map(),
		});
	}

	/** Known absence: ends the lifecycle and drops every field. */
	markAbsent(key: string, validation: Validation): void {
		const current = this.records.get(key);
		this.put({
			key,
			lifecycle: (current?.lifecycle ?? 0) + 1,
			exists: false,
			existence: validation,
			groups: new Map(),
		});
	}

	/** Starts a fresh lifecycle (e.g. a creation event), dropping old fields. */
	restart(key: string, validation: Validation): void {
		const current = this.records.get(key);
		this.put({
			key,
			lifecycle: (current?.lifecycle ?? 0) + 1,
			exists: true,
			existence: validation,
			groups: new Map(),
		});
	}

	/** Authoritatively replaces one field group of an existing resource. */
	setGroup(
		key: string,
		group: string,
		values: Record<string, unknown>,
		validation: Validation,
	): void {
		const current = this.records.get(key);
		if (current?.exists !== true) return;
		const groups = new Map(current.groups);
		groups.set(group, { values, validation, invalid: false });
		this.put({ ...current, groups });
	}

	/** Copies field groups from one identity to another (rename). */
	copyGroups(from: string, to: string): void {
		const source = this.records.get(from);
		const target = this.records.get(to);
		if (!source || target?.exists !== true) return;
		this.put({ ...target, groups: new Map(source.groups) });
	}

	invalidateGroup(key: string, group: string): void {
		const current = this.records.get(key);
		const existing = current?.groups.get(group);
		if (!current || !existing || existing.invalid) return;
		const groups = new Map(current.groups);
		groups.set(group, { ...existing, invalid: true });
		this.put({ ...current, groups });
	}

	setCollection(
		key: string,
		members: Iterable<string>,
		complete: boolean,
		validation: Validation,
	): void {
		this.putCollection({
			key,
			members: new Set(members),
			complete,
			unresolved: new Set(),
			validation,
			invalid: false,
		});
	}

	addMember(key: string, member: string): void {
		const current = this.collections.get(key);
		if (!current) return;
		if (current.members.has(member) && !current.unresolved.has(member)) return;
		const unresolved = new Set(current.unresolved);
		unresolved.delete(member);
		this.putCollection({
			...current,
			members: new Set([...current.members, member]),
			unresolved,
		});
	}

	removeMember(key: string, member: string): void {
		const current = this.collections.get(key);
		if (!current) return;
		if (!current.members.has(member) && !current.unresolved.has(member)) return;
		const members = new Set(current.members);
		members.delete(member);
		const unresolved = new Set(current.unresolved);
		unresolved.delete(member);
		this.putCollection({ ...current, members, unresolved });
	}

	/** Marks a possible member whose membership cannot be decided yet. */
	addUnresolved(key: string, member: string): void {
		const current = this.collections.get(key);
		if (!current || current.unresolved.has(member)) return;
		this.putCollection({
			...current,
			unresolved: new Set([...current.unresolved, member]),
		});
	}

	/** Collections whose key starts with `prefix` (one resource type). */
	collectionsWithPrefix(prefix: string): CollectionRecord[] {
		return [...this.collections.values()].filter((c) =>
			c.key.startsWith(prefix),
		);
	}

	invalidateCollection(key: string): void {
		const current = this.collections.get(key);
		if (!current || current.invalid) return;
		this.putCollection({ ...current, invalid: true });
	}

	private put(record: ResourceRecord): void {
		this.records.set(record.key, record);
		this.touch(record.key);
	}

	private putCollection(collection: CollectionRecord): void {
		this.collections.set(collection.key, collection);
		this.touch(collection.key);
	}

	private touch(key: string): void {
		if (!this.changed) {
			throw new Error("ObservationStore writes must happen inside batch()");
		}
		this.changed.add(key);
	}
}
