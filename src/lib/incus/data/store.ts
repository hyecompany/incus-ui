// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

/** When and under which event coverage a fact was established. */
export interface Validation {
	at: number;
	epoch: number | null;
	/**
	 * Where the fact came from when it was not observed by this tab directly.
	 * "restored": IndexedDB (never fresh: persistence does not establish continuity).
	 * "remote": another tab.
	 */
	source?: "restored" | "remote";
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

/**
 * A directed relationship established by one resource's representation, e.g.
 * profile -> instances from `used_by`. The source owns it: replacing it removes
 * targets that are no longer listed without saying anything about their existence.
 */
export interface RelationRecord {
	key: string;
	from: string;
	kind: string;
	targets: ReadonlySet<string>;
	validation: Validation;
}

/** Plain-data form of a record, for IndexedDB and other tabs. */
export interface RecordSnapshot {
	key: string;
	lifecycle: number;
	exists: boolean | undefined;
	existence?: Validation;
	groups: Array<{
		name: string;
		values: Record<string, unknown>;
		validation: Validation;
		invalid: boolean;
	}>;
}

export interface CollectionSnapshot {
	key: string;
	members: string[];
	complete: boolean;
	validation?: Validation;
	invalid: boolean;
}

type Listener = (changed: ReadonlySet<string>) => void;

/** The resource type of a key: everything before the first NUL. */
export const typeOf = (key: string) => key.slice(0, key.indexOf("\0") + 1);

const relationKey = (from: string, kind: string) => `rel\0${kind}\0${from}`;

/** Shared in-memory state. */
export class ObservationStore {
	private readonly records = new Map<string, ResourceRecord>();
	private readonly collections = new Map<string, CollectionRecord>();
	private readonly relations = new Map<string, RelationRecord>();
	/** Type prefix -> record keys, so a type is looked up without a full scan. */
	private readonly recordIndex = new Map<string, Set<string>>();
	private readonly collectionIndex = new Map<string, Set<string>>();
	/** Relation target -> relation keys pointing at it. */
	private readonly incoming = new Map<string, Set<string>>();
	private readonly listeners = new Set<Listener>();
	private changed: Set<string> | null = null;

	record(key: string): ResourceRecord | undefined {
		return this.records.get(key);
	}

	/** Records of one resource type (`prefix` must be a type prefix ending in NUL). */
	recordsWithPrefix(prefix: string): ResourceRecord[] {
		const keys = this.recordIndex.get(prefix);
		if (!keys) return [];
		return [...keys].map((key) => this.records.get(key) as ResourceRecord);
	}

	collection(key: string): CollectionRecord | undefined {
		return this.collections.get(key);
	}

	/** Collections of one type (`prefix` must be a type prefix ending in NUL). */
	collectionsWithPrefix(prefix: string): CollectionRecord[] {
		const keys = this.collectionIndex.get(prefix);
		if (!keys) return [];
		return [...keys].map(
			(key) => this.collections.get(key) as CollectionRecord,
		);
	}

	relation(from: string, kind: string): RelationRecord | undefined {
		return this.relations.get(relationKey(from, kind));
	}

	/** Relations of `kind` that point at `target`. */
	relationsTo(target: string, kind?: string): RelationRecord[] {
		const keys = this.incoming.get(target);
		if (!keys) return [];
		return [...keys]
			.map((key) => this.relations.get(key) as RelationRecord)
			.filter((r) => kind === undefined || r.kind === kind);
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

	/** Known absence: ends the lifecycle and drops every field and owned relation. */
	markAbsent(key: string, validation: Validation): void {
		const current = this.records.get(key);
		this.put({
			key,
			lifecycle: (current?.lifecycle ?? 0) + 1,
			exists: false,
			existence: validation,
			groups: new Map(),
		});
		this.dropRelationsFrom(key);
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
		this.dropRelationsFrom(key);
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

	/** Forgets a group entirely (it must be fetched again before use). */
	dropGroup(key: string, group: string): void {
		const current = this.records.get(key);
		if (!current?.groups.has(group)) return;
		const groups = new Map(current.groups);
		groups.delete(group);
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

	invalidateCollection(key: string): void {
		const current = this.collections.get(key);
		if (!current || current.invalid) return;
		this.putCollection({ ...current, invalid: true });
	}

	/** Replaces the targets `from` relates to under `kind`. Idempotent. */
	setRelation(
		from: string,
		kind: string,
		targets: Iterable<string>,
		validation: Validation,
	): void {
		const key = relationKey(from, kind);
		const next = new Set(targets);
		const current = this.relations.get(key);
		if (current) {
			for (const target of current.targets) {
				if (!next.has(target)) this.unindexIncoming(target, key);
			}
		}
		for (const target of next) {
			let set = this.incoming.get(target);
			if (!set) {
				set = new Set();
				this.incoming.set(target, set);
			}
			set.add(key);
		}
		this.relations.set(key, { key, from, kind, targets: next, validation });
		this.touch(key);
		if (current)
			for (const target of current.targets)
				if (!next.has(target)) this.touch(target);
		for (const target of next)
			if (!current?.targets.has(target)) this.touch(target);
	}

	/** Every in-memory fact: used by logout and session changes. */
	clear(): void {
		const keys = [
			...this.records.keys(),
			...this.collections.keys(),
			...this.relations.keys(),
		];
		this.records.clear();
		this.collections.clear();
		this.relations.clear();
		this.recordIndex.clear();
		this.collectionIndex.clear();
		this.incoming.clear();
		for (const key of keys) this.touch(key);
	}

	snapshotRecord(key: string): RecordSnapshot | undefined {
		const record = this.records.get(key);
		if (!record) return undefined;
		return {
			key,
			lifecycle: record.lifecycle,
			exists: record.exists,
			existence: record.existence,
			groups: [...record.groups].map(([name, group]) => ({
				name,
				values: { ...group.values },
				validation: group.validation,
				invalid: group.invalid,
			})),
		};
	}

	snapshotCollection(key: string): CollectionSnapshot | undefined {
		const collection = this.collections.get(key);
		if (!collection) return undefined;
		return {
			key,
			members: [...collection.members],
			// Unresolved candidates are not part of a settled answer; drop completeness for them.
			complete: collection.complete && collection.unresolved.size === 0,
			validation: collection.validation,
			invalid: collection.invalid,
		};
	}

	/**
	 * Merges a record observed elsewhere (IndexedDB or another tab). Never lets an
	 * older observation replace a newer one already in memory.
	 */
	mergeRecord(
		snapshot: RecordSnapshot,
		validation: (v: Validation) => Validation,
	): void {
		const current = this.records.get(snapshot.key);
		const existenceAt = snapshot.existence?.at ?? 0;
		const currentAt = current?.existence?.at ?? -1;
		if (
			current?.existence &&
			current.exists !== undefined &&
			snapshot.exists !== undefined &&
			current.exists !== snapshot.exists &&
			currentAt === existenceAt
		) {
			// Same time, opposite answers: ambiguous. Keep it, but require validation.
			this.put({
				...current,
				existence: {
					at: currentAt,
					epoch: null,
					source: current.existence.source,
				},
			});
			return;
		}
		if (snapshot.exists === false) {
			if (current && current.exists !== undefined && currentAt >= existenceAt)
				return;
			if (!snapshot.existence) return;
			this.markAbsent(snapshot.key, validation(snapshot.existence));
			return;
		}
		if (snapshot.exists !== true || !snapshot.existence) return;
		if (current?.exists === false && currentAt >= existenceAt) return;
		if (current?.exists !== true) {
			this.markExists(snapshot.key, validation(snapshot.existence));
		} else if (currentAt < existenceAt) {
			this.put({ ...current, existence: validation(snapshot.existence) });
		}
		const record = this.records.get(snapshot.key) as ResourceRecord;
		const groups = new Map(record.groups);
		let changed = false;
		for (const incoming of snapshot.groups) {
			const existing = groups.get(incoming.name);
			if (existing && existing.validation.at >= incoming.validation.at) {
				// Same observation, but the other side learned it is invalid since.
				if (
					incoming.invalid &&
					!existing.invalid &&
					existing.validation.at === incoming.validation.at
				) {
					groups.set(incoming.name, { ...existing, invalid: true });
					changed = true;
				}
				continue;
			}
			groups.set(incoming.name, {
				values: incoming.values,
				validation: validation(incoming.validation),
				invalid: incoming.invalid,
			});
			changed = true;
		}
		if (changed) this.put({ ...record, groups });
	}

	/** Merges a collection observed elsewhere; never replaces a newer one. */
	mergeCollection(
		snapshot: CollectionSnapshot,
		validation: (v: Validation) => Validation,
	): void {
		const current = this.collections.get(snapshot.key);
		const at = snapshot.validation?.at ?? 0;
		if (current && (current.validation?.at ?? -1) >= at) {
			if (
				snapshot.invalid &&
				!current.invalid &&
				current.validation?.at === at
			) {
				this.invalidateCollection(snapshot.key);
			}
			return;
		}
		this.putCollection({
			key: snapshot.key,
			members: new Set(snapshot.members),
			complete: snapshot.complete,
			unresolved: new Set(),
			validation: snapshot.validation && validation(snapshot.validation),
			invalid: snapshot.invalid,
		});
	}

	private dropRelationsFrom(from: string): void {
		const marker = `\0${from}`;
		for (const [key, relation] of this.relations) {
			if (!key.endsWith(marker) || relation.from !== from) continue;
			for (const target of relation.targets) {
				this.unindexIncoming(target, key);
				this.touch(target);
			}
			this.relations.delete(key);
			this.touch(key);
		}
	}

	private unindexIncoming(target: string, relation: string): void {
		const set = this.incoming.get(target);
		set?.delete(relation);
		if (set?.size === 0) this.incoming.delete(target);
	}

	private put(record: ResourceRecord): void {
		if (!this.records.has(record.key)) index(this.recordIndex, record.key);
		this.records.set(record.key, record);
		this.touch(record.key);
	}

	private putCollection(collection: CollectionRecord): void {
		if (!this.collections.has(collection.key))
			index(this.collectionIndex, collection.key);
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

function index(map: Map<string, Set<string>>, key: string): void {
	const prefix = typeOf(key);
	let set = map.get(prefix);
	if (!set) {
		set = new Set();
		map.set(prefix, set);
	}
	set.add(key);
}
