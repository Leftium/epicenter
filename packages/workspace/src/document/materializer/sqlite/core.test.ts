/**
 * SQLite Materializer Tests
 *
 * Tests the full attachSqliteMaterializerCore lifecycle: DDL generation, full load,
 * incremental sync, FTS5 search, rebuild, and dispose. Uses real Yjs documents
 * with defineTable schemas so the materializer exercises the actual workspace
 * observation path.
 *
 * Key behaviors:
 * - Materializer waits for `whenReady` before touching SQLite
 * - Full load inserts all valid rows on initialization
 * - Observer-based sync upserts changed rows and deletes removed rows
 * - FTS5 search returns ranked results with snippets
 * - rebuild() drops and recreates all materialized data
 * - dispose() stops observers and clears timeouts
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
	createDisposableCache,
	createWorkspace,
	defineTable,
	type Tables,
} from '../../../index.js';
import { isAction, isMutation, isQuery } from '../../../shared/actions.js';
import { column } from '../../column/index.js';
import {
	attachSqliteMaterializerCore,
	type MirrorDatabase,
	type MirrorStatement,
} from './core.js';

const postsTable = defineTable({
	id: column.string(),
	title: column.string(),
	published: column.nullable(column.boolean()),
});

const notesTable = defineTable({
	id: column.string(),
	body: column.string(),
});

const tableDefinitions = { posts: postsTable, notes: notesTable };

const hasFts5 = canUseFts5();

type TestDb = MirrorDatabase & {
	raw: Database;
	sqlCalls: string[];
	close(): void;
};

function createTestDb(): TestDb {
	const raw = new Database(':memory:');
	const sqlCalls: string[] = [];

	return {
		raw,
		sqlCalls,
		close() {
			raw.close();
		},
		run(sql: string) {
			sqlCalls.push(sql);
			return raw.run(sql);
		},
		prepare(sql: string) {
			sqlCalls.push(sql);
			return raw.prepare(sql);
		},
	};
}

type AttachedTables = Tables<typeof tableDefinitions>;

type SetupBuildResult = {
	// biome-ignore lint/suspicious/noExplicitAny: tests build heterogeneous subsets
	tables: Record<string, any>;
	fts?: Record<string, string[]>;
};

type SetupOptions = {
	build?: (t: AttachedTables) => SetupBuildResult;
	debounceMs?: number;
};

function setup({ build, debounceMs }: SetupOptions = {}) {
	const db = createTestDb();

	const cache = createDisposableCache(
		(id: string) => {
			const workspace = createWorkspace({
				id,
				tables: tableDefinitions,
				kv: {},
			});

			const built: SetupBuildResult = build?.(workspace.tables) ?? {
				tables: {
					posts: workspace.tables.posts,
					notes: workspace.tables.notes,
				},
			};

			const materializer = attachSqliteMaterializerCore(workspace.ydoc, {
				db,
				debounceMs,
				tables: built.tables,
				// biome-ignore lint/suspicious/noExplicitAny: tests erase row types through the setup helper
				fts: built.fts as any,
			});

			return {
				ydoc: workspace.ydoc,
				tables: workspace.tables,
				sqlite: materializer,
				[Symbol.dispose]() {
					workspace[Symbol.dispose]();
				},
			};
		},
		{ gcTime: 0 },
	);

	const workspace = cache.open('test');
	return { db, workspace, cache };
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
}

function canUseFts5() {
	const raw = new Database(':memory:');

	try {
		raw.run('CREATE VIRTUAL TABLE test_fts USING fts5(title)');
		return true;
	} catch {
		return false;
	} finally {
		raw.close();
	}
}

async function waitForSyncCycle() {
	await new Promise((resolve) => setTimeout(resolve, 200));
}

function getRows(db: TestDb, tableName: string) {
	return db.raw
		.prepare(`SELECT * FROM "${tableName}" ORDER BY "id"`)
		.all() as Record<string, unknown>[];
}

function hasTable(db: TestDb, tableName: string) {
	const row = db.raw
		.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', tableName);
	return row != null;
}

async function cleanup(setupResult: ReturnType<typeof setup>) {
	setupResult.workspace[Symbol.dispose]();
	setupResult.db.close();
}

// ============================================================================
// READINESS Tests
// ============================================================================

describe('attachSqliteMaterializerCore', () => {
	describe('readiness', () => {
		test('waits for whenReady before touching SQLite', async () => {
			const db = createTestDb();
			const gate = createDeferred();

			const cache = createDisposableCache(
				(id: string) => {
					const workspace = createWorkspace({
						id,
						tables: tableDefinitions,
						kv: {},
					});

					const materializer = attachSqliteMaterializerCore(workspace.ydoc, {
						db,
						waitFor: gate.promise,
						tables: {
							posts: workspace.tables.posts,
							notes: workspace.tables.notes,
						},
					});

					return {
						ydoc: workspace.ydoc,
						tables: workspace.tables,
						sqlite: materializer,
						[Symbol.dispose]() {
							workspace[Symbol.dispose]();
						},
					};
				},
				{ gcTime: 0 },
			);

			const workspace = cache.open('ready-gated');

			try {
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(db.sqlCalls).toHaveLength(0);

				gate.resolve();
				await workspace.sqlite.whenFlushed;

				expect(db.sqlCalls.length).toBeGreaterThan(0);
				expect(hasTable(db, 'posts')).toBe(true);
			} finally {
				gate.resolve();
				workspace[Symbol.dispose]();
				db.close();
			}
		});
	});

	// ============================================================================
	// FULL LOAD Tests
	// ============================================================================

	describe('full load', () => {
		test('mirrors existing rows on initialization', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Hello mirror',
					published: null,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second row',
					published: true,
				});

				await testSetup.workspace.sqlite.whenFlushed;

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Hello mirror' },
					{ id: 'post-2', published: 1, title: 'Second row' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('mirrors only specified tables when tables option is provided', async () => {
			const testSetup = setup({
				build: (t) => ({ tables: { posts: t.posts } }),
			});

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Mirrored post',
					published: null,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Ignored note',
				});

				await testSetup.workspace.sqlite.whenFlushed;

				expect(hasTable(testSetup.db, 'posts')).toBe(true);
				expect(hasTable(testSetup.db, 'notes')).toBe(false);
				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Mirrored post' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// INCREMENTAL SYNC Tests
	// ============================================================================

	describe('incremental sync', () => {
		test('upserts rows added after initialization', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Added later',
					published: true,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: 1, title: 'Added later' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('deletes rows removed from workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Delete me',
					published: null,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.workspace.tables.posts.delete('post-1');

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('updates rows modified in workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Before update',
					published: true,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.workspace.tables.posts.update('post-1', {
					title: 'After update',
					published: false,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: 0, title: 'After update' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// REBUILD Tests
	// ============================================================================

	describe('rebuild', () => {
		test('rebuild repopulates SQLite from Yjs', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Persisted in Yjs',
					published: null,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.db, 'posts')).toEqual([]);

				await testSetup.workspace.sqlite.actions.sqlite_rebuild({});

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Persisted in Yjs' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuild single table without touching others', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Post row',
					published: null,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Note row',
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
				expect(getRows(testSetup.db, 'notes')).toHaveLength(1);

				await testSetup.workspace.sqlite.actions.sqlite_rebuild({
					table: 'posts',
				});

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Post row' },
				]);
				expect(getRows(testSetup.db, 'notes')).toHaveLength(1);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuild throws for unknown table name', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				expect(() =>
					testSetup.workspace.sqlite.actions.sqlite_rebuild({
						table: 'nonexistent',
					}),
				).toThrow('not in the materialized table set');
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// DISPOSE Tests
	// ============================================================================

	describe('dispose', () => {
		test('dispose cancels queued sync and ignores later writes', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Queued row',
					published: null,
				});
				testSetup.workspace[Symbol.dispose]();

				await waitForSyncCycle();

				// The ydoc is destroyed, so further writes to tables are no-ops
				// as far as materialization is concerned; the observer has been
				// unsubscribed via materializer dispose.
				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				testSetup.db.close();
			}
		});

		test('whenDisposed waits for an in-flight incremental sync', async () => {
			const testSetup = setup({ debounceMs: 0 });
			const insertStarted = createDeferred();
			const allowInsert = createDeferred();
			const originalPrepare = testSetup.db.prepare.bind(testSetup.db);
			let insertRunCompleted = false;

			testSetup.db.prepare = async (sql: string): Promise<MirrorStatement> => {
				const statement = await originalPrepare(sql);
				if (!sql.startsWith('INSERT INTO "posts"')) return statement;

				return {
					async run(...params: unknown[]) {
						insertStarted.resolve();
						await allowInsert.promise;
						const result = statement.run(...params);
						insertRunCompleted = true;
						return result;
					},
					all: statement.all.bind(statement),
					get: statement.get.bind(statement),
				};
			};

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'In-flight row',
					published: null,
				});
				await insertStarted.promise;

				let disposed = false;
				testSetup.workspace.sqlite.whenDisposed.then(() => {
					disposed = true;
				});

				testSetup.workspace[Symbol.dispose]();
				await Promise.resolve();

				expect(disposed).toBe(false);
				expect(insertRunCompleted).toBe(false);

				allowInsert.resolve();
				await testSetup.workspace.sqlite.whenDisposed;

				expect(insertRunCompleted).toBe(true);
			} finally {
				testSetup.db.close();
			}
		});
	});

	// ============================================================================
	// SEARCH Tests
	// ============================================================================

	describe('search', () => {
		test('sqlite_search action is absent when fts is not configured', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				// No FTS was passed, so the layer was never constructed and the
				// search action is never added to the registry.
				expect(
					(testSetup.workspace.sqlite.actions as Record<string, unknown>)
						.sqlite_search,
				).toBeUndefined();
			} finally {
				await cleanup(testSetup);
			}
		});

		if (hasFts5) {
			test('search returns ranked results with snippets when fts is configured', async () => {
				const testSetup = setup({
					build: (t) => ({
						tables: { posts: t.posts, notes: t.notes },
						fts: { posts: ['title'] },
					}),
				});

				try {
					testSetup.workspace.tables.posts.set({
						id: 'post-1',
						title: 'Epicenter local-first mirror',
						published: null,
					});
					testSetup.workspace.tables.posts.set({
						id: 'post-2',
						title: 'Another search result',
						published: null,
					});

					await testSetup.workspace.sqlite.whenFlushed;

					const sqliteWithFts = testSetup.workspace.sqlite as unknown as {
						actions: {
							sqlite_search: (
								input: Record<string, unknown>,
							) => Promise<unknown>;
						};
					};
					const results = (await sqliteWithFts.actions.sqlite_search({
						table: 'posts',
						query: 'mirror',
						limit: 10,
					})) as Array<{ id: string; snippet: string; rank: number }>;

					expect(results).toHaveLength(1);
					expect(results[0]?.id).toBe('post-1');
					expect(results[0]?.snippet).toContain('<mark>');
					expect(typeof results[0]?.rank).toBe('number');
				} finally {
					await cleanup(testSetup);
				}
			});

			test('sqlite_search supports snippetColumn', async () => {
				const testSetup = setup({
					build: (t) => ({
						tables: { posts: t.posts },
						fts: { posts: ['published', 'title'] },
					}),
				});

				try {
					testSetup.workspace.tables.posts.set({
						id: 'post-1',
						title: 'Epicenter local-first mirror',
						published: null,
					});

					await testSetup.workspace.sqlite.whenFlushed;

					const sqliteWithFts = testSetup.workspace.sqlite as unknown as {
						actions: {
							sqlite_search: (
								input: Record<string, unknown>,
							) => Promise<unknown>;
						};
					};
					const results = (await sqliteWithFts.actions.sqlite_search({
						table: 'posts',
						query: 'mirror',
						snippetColumn: 'title',
					})) as Array<{ id: string; snippet: string; rank: number }>;
					const fallbackResults = (await sqliteWithFts.actions.sqlite_search({
						table: 'posts',
						query: 'mirror',
						snippetColumn: 'missing',
					})) as Array<{ id: string; snippet: string; rank: number }>;

					expect(results).toHaveLength(1);
					expect(results[0]?.snippet).toContain('<mark>mirror</mark>');
					expect(fallbackResults).toHaveLength(1);
					expect(fallbackResults[0]?.snippet).not.toContain(
						'<mark>mirror</mark>',
					);
				} finally {
					await cleanup(testSetup);
				}
			});
		}
	});

	// ============================================================================
	// ACTION BRAND Tests
	// ============================================================================

	describe('action brand', () => {
		test('sqlite_rebuild is detectable via isAction()', async () => {
			const testSetup = setup();

			try {
				const { sqlite } = testSetup.workspace;
				expect(isAction(sqlite.actions.sqlite_rebuild)).toBe(true);
				expect(isMutation(sqlite.actions.sqlite_rebuild)).toBe(true);
			} finally {
				await cleanup(testSetup);
			}
		});

		if (hasFts5) {
			test('sqlite_search is detectable via isAction() when configured', async () => {
				const testSetup = setup({
					build: (t) => ({
						tables: { posts: t.posts },
						fts: { posts: ['title'] },
					}),
				});

				try {
					await testSetup.workspace.sqlite.whenFlushed;
					const sqliteWithFts = testSetup.workspace.sqlite as unknown as {
						actions: { sqlite_search: unknown };
					};
					expect(isAction(sqliteWithFts.actions.sqlite_search)).toBe(true);
					expect(isQuery(sqliteWithFts.actions.sqlite_search)).toBe(true);
				} finally {
					await cleanup(testSetup);
				}
			});
		}
	});
});
