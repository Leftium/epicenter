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
 * Minimal database interface for the SQLite materializer.
 *
 * Structurally compatible with `@tursodatabase/database` (native) and
 * `@tursodatabase/database-wasm` (browser). The materializer never imports a
 * specific driver—consumers inject whichever they need.
 *
 * @example
 * ```typescript
 * const db: MirrorDatabase = createClientDatabase();
 * await db.exec('PRAGMA journal_mode = WAL');
 * ```
 */
export type MirrorDatabase = {
	/** Execute raw SQL that does not return rows. */
	exec(sql: string): Promise<void>;

	/** Prepare a reusable statement for repeated reads or writes. */
	prepare(sql: string): MirrorStatement;
};

/**
 * Minimal prepared statement interface used by the SQLite materializer.
 *
 * The materializer only needs async write, many-row read, and single-row read
 * primitives. Keeping this structural lets callers use native or WASM-backed
 * Turso drivers with the same extension API.
 *
 * @example
 * ```typescript
 * const statement = db.prepare('SELECT * FROM posts WHERE id = ?');
 * const row = await statement.get('post_123');
 * ```
 */
export type MirrorStatement = {
	/** Run a statement that writes data or otherwise returns no rows. */
	run(...params: unknown[]): Promise<void>;

	/** Fetch all matching rows as plain objects. */
	all(...params: unknown[]): Promise<Record<string, unknown>[]>;

	/** Fetch the first matching row, if one exists. */
	get(...params: unknown[]): Promise<Record<string, unknown> | undefined>;
};

/**
 * Per-table configuration for the SQLite materializer builder.
 *
 * Passed to `.table(name, config?)` to customize FTS5 indexing
 * and value serialization for individual tables.
 *
 * @example
 * ```typescript
 * createSqliteMaterializer(ctx, { db })
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
