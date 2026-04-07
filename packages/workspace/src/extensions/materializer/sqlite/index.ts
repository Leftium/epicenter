/**
 * SQLite mirror extension — auto-materializes Yjs table data into SQLite.
 *
 * Yjs stays the source of truth; SQLite is a derived, rebuildable read cache.
 * Provides SQL queries, full-text search (FTS5), and lifecycle hooks for
 * vector columns and custom indexes.
 *
 * @module
 */

export { createSqliteMirror } from './create-sqlite-mirror.js';
export { generateDdl, resolveSchema } from './ddl.js';
export type {
	MirrorDatabase,
	MirrorStatement,
	SearchOptions,
	SearchResult,
	SqliteMirror,
	SqliteMirrorOptions,
	SyncChange,
} from './types.js';
