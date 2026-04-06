/**
 * Public type surface for the SQLite mirror workspace extension.
 *
 * This module stays implementation-free on purpose. Consumers can import the
 * mirror's options, callbacks, search types, and injected database contract
 * without pulling in a specific SQLite driver.
 *
 * @packageDocumentation
 */

/**
 * Minimal database interface for the SQLite mirror.
 *
 * Structurally compatible with `@tursodatabase/database` (native) and
 * `@tursodatabase/database-wasm` (browser). The mirror never imports a
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
 * Minimal prepared statement interface used by the SQLite mirror.
 *
 * The mirror only needs async write, many-row read, and single-row read
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
 * Configuration for `createSqliteMirror`.
 *
 * Use this to choose the injected database, limit which workspace tables get
 * mirrored, opt into FTS5 search, and hook into lifecycle events.
 *
 * @example
 * ```typescript
 * const options: SqliteMirrorOptions = {
 *   db,
 *   tables: ['posts', 'notes'],
 *   fts: { posts: ['title', 'body'] },
 *   debounceMs: 100,
 * };
 * ```
 */
export type SqliteMirrorOptions = {
	/** Turso database instance. Caller chooses driver and storage mode. */
	db: MirrorDatabase;

	/** Which tables to mirror. Default: all workspace tables. */
	tables?: 'all' | string[];

	/** FTS5 config. Map of table name → column names to index. */
	fts?: Record<string, string[]>;

	/** Called after mirror tables created and initial data loaded. */
	onReady?: (db: MirrorDatabase) => void | Promise<void>;

	/** Called after each sync cycle with change details. */
	onSync?: (db: MirrorDatabase, changes: SyncChange[]) => void | Promise<void>;

	/** Debounce interval in milliseconds before applying queued sync work. @default 100 */
	debounceMs?: number;
};

/**
 * Summary of how one table changed during a sync cycle.
 *
 * Use this in `onSync` callbacks to react to fresh upserts and deletions
 * without re-querying the whole mirror.
 */
export type SyncChange = {
	/** Mirrored table name. */
	table: string;

	/** Row IDs that were inserted or updated. */
	upserted: string[];

	/** Row IDs that were deleted. */
	deleted: string[];
};

/**
 * Public API returned by the SQLite mirror extension.
 *
 * Includes the injected database for custom SQL, a full rebuild operation,
 * optional FTS5 search, and lifecycle hooks consumed by the workspace framework.
 *
 * @example
 * ```typescript
 * await mirror.whenReady;
 * await mirror.rebuild();
 * const results = await mirror.search('posts', 'local-first');
 * mirror.dispose();
 * ```
 */
export type SqliteMirror = {
	/** Database instance for arbitrary SQL queries. */
	db: MirrorDatabase;

	/** Resolves after DDL creation, initial load, and FTS setup complete. */
	whenReady: Promise<void>;

	/** Rebuild all mirrored tables from Yjs. Drops and recreates. */
	rebuild: () => Promise<void>;

	/**
	 * Rebuild a single mirrored table from Yjs without touching others.
	 *
	 * Useful when one table drifts or after a schema migration. Throws if
	 * the table name is not in the mirrored set.
	 */
	rebuildTable: (tableName: string) => Promise<void>;

	/**
	 * Return the row count for a mirrored table.
	 *
	 * Convenience wrapper around `SELECT COUNT(*) FROM table`. Returns 0
	 * for tables that haven't been loaded yet or don't exist.
	 *
	 * @example
	 * ```typescript
	 * const n = await mirror.count('posts');
	 * console.log(`${n} posts mirrored`);
	 * ```
	 */
	count: (tableName: string) => Promise<number>;

	/** FTS5 search. Only useful if `fts` config was provided. */
	search: (
		table: string,
		query: string,
		options?: SearchOptions,
	) => Promise<SearchResult[]>;

	/** Stop observers and cancel pending sync. */
	dispose: () => void;
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
 * One full-text search result returned by the mirror.
 *
 * `id` points back to the mirrored row, `snippet` is display-ready text, and
 * `rank` is the database-provided relevance score.
 */
export type SearchResult = {
	/** ID of the mirrored row that matched the query. */
	id: string;

	/** Snippet generated from indexed text content. */
	snippet: string;

	/** Relevance score returned by the FTS query. */
	rank: number;
};
