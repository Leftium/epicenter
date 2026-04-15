/**
 * Public type surface for the SQLite materializer.
 *
 * This module stays implementation-free on purpose. Consumers can import the
 * materializer's config types, search types, and injected database contract
 * without pulling in a specific SQLite driver.
 *
 * @packageDocumentation
 */

/**
 * A value that may or may not be wrapped in a Promise.
 *
 * Used throughout the materializer's database contract so that both synchronous
 * drivers (`bun:sqlite`, `better-sqlite3`) and asynchronous drivers
 * (`@tursodatabase/database-wasm`, `@libsql/client-wasm`) satisfy the same
 * interface. The materializer `await`s every call internally, which is a no-op
 * for sync return values.
 */
export type Awaitable<T> = T | Promise<T>;

/**
 * Minimal database interface for the SQLite materializer.
 *
 * Structurally compatible with sync drivers (`bun:sqlite`, `better-sqlite3`)
 * and async WASM drivers (`@tursodatabase/database-wasm`). The materializer
 * `await`s every call, so sync drivers work without any adapter.
 *
 * @example Sync driver (Bun/Node)
 * ```typescript
 * import { Database } from 'bun:sqlite';
 * const db: MirrorDatabase = new Database('materializer.db');
 * ```
 *
 * @example Async WASM driver (browser)
 * ```typescript
 * import { connect } from '@tursodatabase/database-wasm';
 * const db: MirrorDatabase = await connect(':memory:');
 * ```
 */
export type MirrorDatabase = {
	/** Execute raw SQL that does not return rows. */
	run(sql: string): Awaitable<unknown>;

	/** Prepare a reusable statement for repeated reads or writes. */
	prepare(sql: string): MirrorStatement;
};

/**
 * Minimal prepared statement interface used by the SQLite materializer.
 *
 * Structurally compatible with both sync (`bun:sqlite`) and async
 * (`@tursodatabase/database-wasm`) statement objects. The materializer
 * `await`s every method call internally.
 *
 * @example
 * ```typescript
 * const stmt = db.prepare('SELECT * FROM posts WHERE id = ?');
 * const row = await stmt.get('post_123');
 * ```
 */
export type MirrorStatement = {
	/** Run a statement that writes data or otherwise returns no rows. */
	run(...params: unknown[]): Awaitable<unknown>;

	/** Fetch all matching rows as plain objects. */
	all(...params: unknown[]): Awaitable<Record<string, unknown>[]>;

	/** Fetch the first matching row, or null if none found. */
	get(...params: unknown[]): Awaitable<Record<string, unknown> | null>;
};

/**
 * Per-table configuration for the SQLite materializer builder.
 *
 * Passed to `.table(name, config?)` to customize FTS5 indexing
 * and value serialization for individual tables.
 *
 * @example
 * ```typescript
 * createSqliteMaterializer(ctx, { db: new Database(':memory:') })
 *   .table('posts', {
 *     fts: ['title', 'body'],
	 *     serialize: (value) => customTransform(value),
 *   })
 * ```
 */
export type TableMaterializerConfig = {
	/** Column names to include in FTS5 full-text search index. */
	fts?: string[];

	/** Optional per-column value serializer override. */
	serialize?: (value: unknown) => unknown;
};

/**
 * Optional arguments for FTS5 searches.
 *
 * Use this when you want to cap result count or choose which indexed column is
 * used for snippets in the search response.
 */
export type SearchOptions = {
	/** Maximum number of matches to return. */
	limit?: number;

	/** Column name used to generate the snippet text. */
	snippetColumn?: string;
};

/**
 * One full-text search result returned by the materializer.
 *
 * `id` points back to the materialized row, `snippet` is display-ready text, and
 * `rank` is the database-provided relevance score.
 */
export type SearchResult = {
	/** ID of the materialized row that matched the query. */
	id: string;

	/** Snippet generated from indexed text content. */
	snippet: string;

	/** Relevance score returned by the FTS query. */
	rank: number;
};
