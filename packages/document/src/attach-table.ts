/**
 * attachTable() — Bind a TableDefinition to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('table:<name>')`
 * and wraps it with a typed `TableHelper`. Provides CRUD operations with
 * schema validation and migration on read.
 *
 * For encrypted storage and full workspace lifecycle (extensions, KV,
 * awareness, documents), use `createWorkspace` from `@epicenter/workspace`.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { defineTable, attachTable } from '@epicenter/document';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const postsTable = attachTable(ydoc, 'posts', posts);
 * postsTable.set({ id: '1', title: 'Hello', _v: 1 });
 * ```
 */

import type * as Y from 'yjs';
import type {
	GetResult,
	InferTableRow,
	InvalidRowResult,
	RowResult,
	TableDefinition,
	TableHelper,
	UpdateResult,
} from './types.js';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

/** Build the Y.Array key for a table by name. */
function tableArrayKey(name: string): `table:${string}` {
	return `table:${name}`;
}

/**
 * Bind a single TableDefinition to a Y.Doc and return a typed TableHelper.
 *
 * Creates (or reuses) a Y.Array at `table:<name>` and wraps it with an
 * unencrypted `YKeyValueLww` store.
 *
 * @param ydoc - The Y.Doc to attach to
 * @param name - The table name (used as the Y.Array key)
 * @param definition - The table definition with schema and migration
 */
export function attachTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	name: string,
	definition: TTableDefinition,
): TableHelper<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(tableArrayKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.on('destroy', () => ykv.dispose());
	return tableHelperOver(ykv, definition);
}

/**
 * Build a TableHelper over any LWW-shaped store. Shared between
 * `attachTable` (unencrypted) and `@epicenter/workspace`'s `createTable`
 * (encrypted wrapper). Both stores expose the same surface: `set`, `get`,
 * `delete`, `bulkSet`, `bulkDelete`, `observe`, `unobserve`, plus a
 * `readableEntries()`/`readableEntryCount` for iteration.
 *
 * For the unencrypted path, `readableEntries`/`readableEntryCount` map
 * directly to the underlying YKeyValueLww `entries()` / `_map.size`.
 */
type LwwStoreLike = {
	set(key: string, val: unknown): void;
	get(key: string): unknown;
	has(key: string): boolean;
	delete(key: string): void;
	bulkSet(entries: Array<{ key: string; val: unknown }>): void;
	bulkDelete(keys: string[]): void;
	observe(handler: LwwObserver): void;
	unobserve(handler: LwwObserver): void;
	readableEntries(): IterableIterator<[string, YKeyValueLwwEntry<unknown>]>;
	readonly readableEntryCount: number;
};

type LwwObserver = (
	changes: Map<string, YKeyValueLwwChange<unknown>>,
	origin: unknown,
) => void;

/** Adapt an unencrypted YKeyValueLww to the LwwStoreLike contract. */
function adaptYkvLww(ykv: YKeyValueLww<unknown>): LwwStoreLike {
	// Wrappers around outer handlers so unobserve() finds the same identity.
	const handlerMap = new WeakMap<
		LwwObserver,
		Parameters<typeof ykv.observe>[0]
	>();
	return {
		set: (key, val) => ykv.set(key, val),
		get: (key) => ykv.get(key),
		has: (key) => ykv.has(key),
		delete: (key) => ykv.delete(key),
		bulkSet: (entries) => ykv.bulkSet(entries),
		bulkDelete: (keys) => ykv.bulkDelete(keys),
		observe: (handler) => {
			// Forward `transaction.origin` (not the full transaction) so the surface
			// matches the encrypted wrapper used by `@epicenter/workspace`.
			const inner: Parameters<typeof ykv.observe>[0] = (changes, transaction) =>
				handler(changes, transaction.origin);
			handlerMap.set(handler, inner);
			ykv.observe(inner);
		},
		unobserve: (handler) => {
			const inner = handlerMap.get(handler);
			if (inner) {
				ykv.unobserve(inner);
				handlerMap.delete(handler);
			}
		},
		*readableEntries() {
			yield* ykv.entries();
		},
		get readableEntryCount() {
			return ykv.map.size;
		},
	};
}

/**
 * Construct a TableHelper from any LWW-shaped store and a TableDefinition.
 *
 * Exported so `@epicenter/workspace` can reuse the exact same helper logic
 * over its encrypted store wrapper.
 */
export function tableHelperOver<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	store: YKeyValueLww<unknown> | LwwStoreLike,
	definition: TTableDefinition,
): TableHelper<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;
	const ykv: LwwStoreLike =
		store instanceof YKeyValueLww ? adaptYkvLww(store) : store;

	/**
	 * Parse and migrate a raw row value. Injects `id` into the input before validation.
	 */
	function parseRow(id: string, input: unknown): RowResult<TRow> {
		const row = { ...(input as Record<string, unknown>), id };
		const result = definition.schema['~standard'].validate(row);
		if (result instanceof Promise)
			throw new TypeError('Async schemas not supported');
		if (result.issues)
			return { status: 'invalid', id, errors: result.issues, row };
		const migrated = definition.migrate(result.value) as TRow;
		return { status: 'valid', row: migrated };
	}

	return {
		parse(id: string, input: unknown): RowResult<TRow> {
			return parseRow(id, input);
		},

		set(row: TRow): void {
			ykv.set(row.id, row);
		},

		async bulkSet(
			rows: TRow[],
			options?: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			},
		): Promise<void> {
			const { chunkSize = 1000, onProgress } = options ?? {};
			const total = rows.length;

			for (let i = 0; i < total; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize);
				ykv.bulkSet(chunk.map((row) => ({ key: row.id, val: row })));
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow> {
			const current = this.get(id);
			if (current.status !== 'valid') return current;

			const merged = { ...current.row, ...partial, id };
			const result = parseRow(id, merged);
			if (result.status === 'invalid') return result;

			this.set(result.row);
			return { status: 'updated', row: result.row };
		},

		get(id: string): GetResult<TRow> {
			const raw = ykv.get(id);
			if (raw === undefined) {
				return { status: 'not_found', id, row: undefined };
			}
			return parseRow(id, raw);
		},

		getAll(): RowResult<TRow>[] {
			const results: RowResult<TRow>[] = [];
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				results.push(result);
			}
			return results;
		},

		getAllValid(): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid') {
					rows.push(result.row);
				}
			}
			return rows;
		},

		getAllInvalid(): InvalidRowResult[] {
			const invalid: InvalidRowResult[] = [];
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'invalid') {
					invalid.push(result);
				}
			}
			return invalid;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					rows.push(result.row);
				}
			}
			return rows;
		},

		find(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					return result.row;
				}
			}
			return undefined;
		},

		delete(id: string): void {
			ykv.delete(id);
		},

		async bulkDelete(
			ids: string[],
			options?: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			},
		): Promise<void> {
			const { chunkSize = 2500, onProgress } = options ?? {};
			const total = ids.length;

			for (let i = 0; i < total; i += chunkSize) {
				const chunk = ids.slice(i, i + chunkSize);
				ykv.bulkDelete(chunk);
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		clear(): void {
			const keys = Array.from(ykv.readableEntries()).map(([k]) => k);
			ykv.bulkDelete(keys);
		},

		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
		): () => void {
			const handler: LwwObserver = (changes, origin) => {
				callback(new Set(changes.keys()) as ReadonlySet<TRow['id']>, origin);
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		count(): number {
			return ykv.readableEntryCount;
		},

		has(id: string): boolean {
			return ykv.has(id);
		},
	};
}
