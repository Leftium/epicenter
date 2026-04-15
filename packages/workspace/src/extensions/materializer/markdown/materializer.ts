import type { MaybePromise } from '../../../workspace/lifecycle.js';
import type { KvHelper, TableHelper } from '../../../workspace/types.js';
import type { SerializeResult } from './markdown.js';

/**
 * Filesystem operations the materializer needs. Inject a custom adapter to run
 * in runtimes other than Node/Bun (e.g. Tauri's `@tauri-apps/plugin-fs`).
 *
 * When omitted, defaults to Node's `fs/promises` + `path.join` which also
 * work in Bun.
 */
export type MaterializerIO = {
	mkdir(dir: string): Promise<void>;
	writeFile(path: string, content: string): Promise<void>;
	removeFile(path: string): Promise<void>;
	joinPath(...segments: string[]): MaybePromise<string>;
};

/**
 * YAML serialization adapter. Inject a custom implementation to avoid the
 * `bun` global (e.g. `js-yaml` or `yaml` npm package).
 *
 * When omitted, defaults to `YAML.stringify` from the `bun` global.
 */
export type MaterializerYaml = {
	stringify(obj: Record<string, unknown>): string;
};

/** Lazily resolve Node/Bun default IO. Only imported when actually used. */
function createDefaultIO(): MaterializerIO {
	// Dynamic require avoids top-level import that would fail in browser runtimes.
	const fs = require('node:fs/promises') as typeof import('node:fs/promises');
	const path = require('node:path') as typeof import('node:path');

	return {
		mkdir: (dir) => fs.mkdir(dir, { recursive: true }),
		writeFile: (filePath, content) => fs.writeFile(filePath, content),
		removeFile: (filePath) => fs.unlink(filePath).catch(() => {}),
		joinPath: (...segments) => path.join(...segments),
	};
}

/** Lazily resolve Bun YAML default. Only called when no yaml adapter is provided. */
function createDefaultYaml(): MaterializerYaml {
	const { YAML } = require('bun') as typeof import('bun');
	return {
		stringify: (obj) => YAML.stringify(obj, null, 2) as string,
	};
}

/**
 * Build a markdown string from YAML frontmatter and an optional body.
 *
 * Pure function—no I/O. Uses the provided YAML stringifier.
 * Undefined values are stripped; null values are preserved.
 */
function buildMarkdown(
	yaml: MaterializerYaml,
	frontmatter: Record<string, unknown>,
	body?: string,
): string {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value !== undefined) {
			cleaned[key] = value;
		}
	}
	const yamlStr = yaml.stringify(cleaned);
	const yamlBlock = yamlStr.endsWith('\n') ? yamlStr : `${yamlStr}\n`;
	return body !== undefined
		? `---\n${yamlBlock}---\n\n${body}\n`
		: `---\n${yamlBlock}---\n`;
}

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
 * Pass `io` and `yaml` to run in non-Node/Bun runtimes (e.g. Tauri):
 *
 * @example
 * ```typescript
 * // Bun/Node — defaults just work
 * .withWorkspaceExtension('materializer', (ctx) =>
 *   createMarkdownMaterializer(ctx, { dir: './data' })
 *     .table('posts', { serialize: slugFilename('title') })
 *     .kv(),
 * )
 *
 * // Tauri — inject filesystem + YAML adapters
 * .withWorkspaceExtension('materializer', (ctx) =>
 *   createMarkdownMaterializer(ctx, {
 *     dir: recordingsPath,
 *     io: {
 *       mkdir: (dir) => tauriMkdir(dir, { recursive: true }),
 *       writeFile: tauriWriteTextFile,
 *       removeFile: (path) => tauriRemove(path).catch(() => {}),
 *       joinPath: (...s) => tauriJoin(...s),
 *     },
 *     yaml: { stringify: (obj) => jsYaml.dump(obj, { lineWidth: -1 }) },
 *   })
 *     .table('recordings', { serialize: mySerializer }),
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
	config: {
		dir: string;
		/** Filesystem adapter. Defaults to Node `fs/promises` + `path.join` (works in Bun). */
		io?: MaterializerIO;
		/** YAML serializer. Defaults to `YAML.stringify` from the `bun` global. */
		yaml?: MaterializerYaml;
	},
) {
	const io = config.io ?? createDefaultIO();
	const yaml = config.yaml ?? createDefaultYaml();

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
		const directory = await io.joinPath(config.dir, tableConfig?.dir ?? name);
		const filenames = new Map<string, string>();

		const serialize: (row: TableRow<TName>) => MaybePromise<SerializeResult> =
			tableConfig?.serialize ??
			((row) => ({
				filename: `${row.id}.md`,
				content: buildMarkdown(yaml, { ...row }),
			}));

		await io.mkdir(directory);

		for (const row of table.getAllValid()) {
			const result = await serialize(row);
			await io.writeFile(await io.joinPath(directory, result.filename), result.content);
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
							await io.removeFile(await io.joinPath(directory, previousFilename));
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
						await io.removeFile(await io.joinPath(directory, previousFilename));
					}

					await io.writeFile(await io.joinPath(directory, result.filename), result.content);
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
		await io.writeFile(await io.joinPath(config.dir, initial.filename), initial.content);

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
				await io.writeFile(await io.joinPath(config.dir, result.filename), result.content);
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
			await io.mkdir(config.dir);

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
