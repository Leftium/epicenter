import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaybePromise } from '../../../workspace/lifecycle.js';
import type { KvHelper, TableHelper } from '../../../workspace/types.js';
import { markdown, type SerializeResult } from './markdown.js';

/** Delete a file, silently succeeding if it doesn't exist or can't be removed. */
const safeUnlink = (filePath: string) => unlink(filePath).catch(() => {});

/**
 * Create a one-way materializer that writes workspace data to files on disk.
 *
 * Nothing materializes by default. Call `.table()` to opt in per table and
 * `.kv()` to opt in KV. Each `.table()` call validates the table name against
 * the workspace definition and infers the row type for the serialize callback.
 *
 * The materializer awaits `ctx.whenReady` before reading data, so persistence
 * and sync have loaded before the initial flush. All `.table()` and `.kv()`
 * calls happen synchronously in the factory closure before `whenReady` resolves.
 *
 * @example
 * ```typescript
 * .withWorkspaceExtension('materializer', (ctx) =>
 *   createMarkdownMaterializer(ctx, { dir: './data' })
 *     .table('posts', { serialize: slugFilename('title') })
 *     .table('settings')
 *     .kv(),
 * )
 * ```
 */
export function createMarkdownMaterializer<
	// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous table helpers
	TTables extends Record<string, TableHelper<any>>,
	// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous kv helpers
	TKv extends KvHelper<any>,
>(
	ctx: { tables: TTables; kv: TKv; whenReady: Promise<void> },
	config: { dir: string },
) {
	type TableConfigByName = {
		[TName in keyof TTables & string]?: {
			dir?: string;
			serialize?: TTables[TName] extends TableHelper<infer TRow>
				? (row: TRow) => MaybePromise<SerializeResult>
				: never;
		};
	};

	type TableRow<TName extends keyof TTables & string> =
		TTables[TName] extends TableHelper<infer TRow> ? TRow : never;

	type MaterializerBuilder = {
		table<TName extends keyof TTables & string>(
			name: TName,
			config?: {
				dir?: string;
				serialize?: TTables[TName] extends TableHelper<infer TRow>
					? (row: TRow) => MaybePromise<SerializeResult>
					: never;
			},
		): MaterializerBuilder;
		/**
		 * Opt in to KV materialization.
		 *
		 * Writes a single file (default: `kv.json`) containing all KV values.
		 * The initial snapshot is seeded via `kv.getAll()`, then kept current
		 * via `kv.observeAll()`. Custom serialize receives the accumulated
		 * state and returns `SerializeResult`.
		 */
		kv(config?: {
			serialize?: (data: Record<string, unknown>) => SerializeResult;
		}): MaterializerBuilder;
		whenReady: Promise<void>;
		dispose(): void;
	};

	const tableConfigs: TableConfigByName = {};
	const tableNames = new Set<keyof TTables & string>();
	let kvConfig:
		| {
				serialize?: (data: Record<string, unknown>) => SerializeResult;
		  }
		| undefined;
	let shouldMaterializeKv = false;
	const unsubscribers: Array<() => void> = [];

	const materializeTable = async <TName extends keyof TTables & string>(
		name: TName,
	) => {
		const table = ctx.tables[name];
		const tableConfig = tableConfigs[name];
		const directory = join(config.dir, tableConfig?.dir ?? name);
		const filenames = new Map<string, string>();

		const serialize: (row: TableRow<TName>) => MaybePromise<SerializeResult> =
			tableConfig?.serialize ??
			((row) =>
				markdown({
					frontmatter: { ...row },
					filename: `${row.id}.md`,
				}));

		await mkdir(directory, { recursive: true });

		for (const row of table.getAllValid()) {
			const result = await serialize(row);
			await Bun.write(join(directory, result.filename), result.content);
			filenames.set(row.id, result.filename);
		}

		// Sequential writes inside the observer avoid rename races — a parallel
		// approach (Promise.allSettled) could delete a file another write needs.
		const unsubscribe = table.observe((changedIds) => {
			void (async () => {
				for (const id of changedIds) {
					const getResult = table.get(id);

					if (getResult.status === 'not_found') {
						const previousFilename = filenames.get(id);
						if (previousFilename) {
							await safeUnlink(join(directory, previousFilename));
							filenames.delete(id);
						}
						continue;
					}

					if (getResult.status !== 'valid') {
						continue;
					}

					const result = await serialize(getResult.row);
					const previousFilename = filenames.get(id);

					if (previousFilename && previousFilename !== result.filename) {
						await safeUnlink(join(directory, previousFilename));
					}

					await Bun.write(join(directory, result.filename), result.content);
					filenames.set(id, result.filename);
				}
			})().catch((error) => {
				console.warn('[markdown-materializer] table write failed:', error);
			});
		});

		unsubscribers.push(unsubscribe);
	};

	const materializeKv = async () => {
		const kvState: Record<string, unknown> = { ...ctx.kv.getAll() };
		const serialize =
			kvConfig?.serialize ??
			((data: Record<string, unknown>) => ({
				filename: 'kv.json',
				content: JSON.stringify(data, null, 2),
			}));

		// Initial flush with the full snapshot
		const initial = serialize(kvState);
		await Bun.write(join(config.dir, initial.filename), initial.content);

		const unsubscribe = ctx.kv.observeAll((changes) => {
			void (async () => {
				for (const [key, change] of changes) {
					if (change.type === 'set') {
						kvState[key] = change.value;
						continue;
					}

					delete kvState[key];
				}

				const result = serialize(kvState);
				await Bun.write(join(config.dir, result.filename), result.content);
			})().catch((error) => {
				console.warn('[markdown-materializer] kv write failed:', error);
			});
		});

		unsubscribers.push(unsubscribe);
	};

	const builder: MaterializerBuilder = {
		table(name, tableConfig) {
			tableNames.add(name);
			if (tableConfig) tableConfigs[name] = tableConfig;
			return builder;
		},
		kv(nextKvConfig) {
			shouldMaterializeKv = true;
			kvConfig = nextKvConfig;
			return builder;
		},
		whenReady: (async () => {
			await ctx.whenReady;
			await mkdir(config.dir, { recursive: true });

			for (const name of tableNames) {
				await materializeTable(name);
			}

			if (shouldMaterializeKv) {
				await materializeKv();
			}
		})(),
		dispose() {
			for (const unsubscribe of unsubscribers.splice(0)) {
				unsubscribe();
			}
		},
	};

	return builder;
}
