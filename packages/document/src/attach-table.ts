/**
 * attachTable() — Bind a TableDefinition to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('table:<name>')`
 * and wraps it with a typed `Table`. Provides CRUD operations with
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
import { TableKey } from './keys.js';
import type {
	GetResult,
	InferTableRow,
	InvalidRowResult,
	RowResult,
	Table,
	TableDefinition,
	UpdateResult,
} from './types.js';
import {
	type KvStoreChangeHandler,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

/**
 * Bind a single TableDefinition to a Y.Doc and return a typed Table.
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
): Table<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.on('destroy', () => ykv.dispose());
	return createTable(ykv, definition);
}

/**
 * Construct a Table from any `ObservableKvStore` and a TableDefinition.
 *
 * Exported so `@epicenter/workspace` can reuse the exact same helper logic
 * over its encrypted store wrapper.
 */
export function createTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;

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
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				results.push(result);
			}
			return results;
		},

		getAllValid(): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid') {
					rows.push(result.row);
				}
			}
			return rows;
		},

		getAllInvalid(): InvalidRowResult[] {
			const invalid: InvalidRowResult[] = [];
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'invalid') {
					invalid.push(result);
				}
			}
			return invalid;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					rows.push(result.row);
				}
			}
			return rows;
		},

		find(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const [key, entry] of ykv.entries()) {
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
			const keys = Array.from(ykv.entries()).map(([k]) => k);
			ykv.bulkDelete(keys);
		},

		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
		): () => void {
			const handler: KvStoreChangeHandler<unknown> = (changes, origin) => {
				callback(new Set(changes.keys()) as ReadonlySet<TRow['id']>, origin);
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		count(): number {
			return ykv.size;
		},

		has(id: string): boolean {
			return ykv.has(id);
		},
	};
}
