/**
 * `queryBooks`: read-only SQL over the local QuickBooks mirror. The `query` CLI
 * verb is a thin adapter over this; an off-the-shelf coding agent pointed at
 * `books.db` is the other consumer. The data leaves the machine only as the rows
 * this returns, the egress ADR-0033 already accepts.
 *
 * Read-only is enforced by the connection, not a string check:
 * `new Database(path, { readonly: true })` makes SQLite reject every write
 * statement, so even arbitrary SQL cannot mutate the mirror. Results are
 * row-capped so a broad query cannot flood a caller (or a model's context).
 *
 * This core is the seam ADR-0072 leaves open: a future daemon re-exposes it with
 * `defineQuery({ handler: queryBooks })` without changing this function.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const BooksQueryError = defineErrors({
	NoMirror: ({ path }: { path: string }) => ({
		message: `No QuickBooks mirror at ${path}. Run "local-books sync --full" first.`,
	}),
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: `Read-only query failed (the mirror rejects writes): ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type BooksQueryError = InferErrors<typeof BooksQueryError>;

/** Cap returned rows so a broad query cannot flood the caller. */
const MAX_ROWS = 1000;

export type BooksQueryResult = {
	rows: Record<string, unknown>[];
	/** Rows the query matched, which may exceed the returned (capped) count. */
	rowCount: number;
	truncated: boolean;
};

/**
 * Run a read-only SQL query against the mirror at `dbPath`. The handle is opened
 * read-only per call (cheap, and it sidesteps holding a lock while a sync
 * writes), so a query can run while `local-books sync` runs.
 */
export function queryBooks({
	dbPath,
	sql,
}: {
	dbPath: string;
	sql: string;
}): Result<BooksQueryResult, BooksQueryError> {
	if (!existsSync(dbPath)) return BooksQueryError.NoMirror({ path: dbPath });
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db.query(sql).all() as Record<string, unknown>[];
		const truncated = rows.length > MAX_ROWS;
		return Ok({
			rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
			rowCount: rows.length,
			truncated,
		});
	} catch (cause) {
		return BooksQueryError.QueryFailed({ cause });
	} finally {
		db.close();
	}
}
