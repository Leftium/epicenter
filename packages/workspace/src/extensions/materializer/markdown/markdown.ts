import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { YAML } from 'bun';
import { Ok, tryAsync } from 'wellcrafted/result';
import type { ExtensionContext } from '../../../workspace/types.js';
import { defaultSerializer, type MarkdownSerializer } from './serializers.js';

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * Assemble a markdown string from YAML frontmatter and an optional body.
 *
 * Pure function — no I/O. Uses `Bun.YAML.stringify` for spec-compliant
 * serialization (handles quoting of booleans, numeric strings, special
 * characters, newlines, etc.). Null/undefined frontmatter values are
 * stripped so the output stays clean.
 */
function toMarkdown(
	frontmatter: Record<string, unknown>,
	body?: string,
): string {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value !== undefined && value !== null) {
			cleaned[key] = value;
		}
	}
	const yaml = YAML.stringify(cleaned, null, 2);
	return body !== undefined
		? `---\n${yaml}---\n\n${body}\n`
		: `---\n${yaml}---\n`;
}

/** Delete a file, silently succeeding if it doesn't exist or can't be removed. */
async function safeUnlink(filePath: string): Promise<void> {
	await tryAsync({
		try: () => unlink(filePath),
		catch: () => Ok(undefined),
	});
}

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Configuration for the markdown materializer extension.
 *
 * Specifies the root output directory and which tables to materialize.
 * Only tables explicitly listed in `tables` are materialized—unlisted
 * tables are ignored. This is intentional: materializing everything by
 * default could produce unexpected files.
 *
 * @example
 * ```typescript
 * const config: MarkdownMaterializerConfig = {
 *   directory: './data',
 *   tables: {
 *     savedTabs: { serializer: titleFilenameSerializer('title') },
 *     bookmarks: { serializer: titleFilenameSerializer('title') },
 *     devices: {}, // uses defaultSerializer
 *   },
 * };
 * ```
 */
export type MarkdownMaterializerConfig = {
	/** Root directory for markdown output. */
	directory: string;
	/**
	 * Per-table configuration. Only tables listed here are materialized
	 * (explicit opt-in). Tables not listed are ignored entirely.
	 *
	 * Pass `{}` to use {@link defaultSerializer}, or provide a custom
	 * `serializer` and/or `directory` override.
	 */
	tables: Record<
		string,
		{
			/** Subdirectory name within the root. Defaults to the table key name. */
			directory?: string;
			/** Custom serializer. Defaults to {@link defaultSerializer}. */
			serializer?: MarkdownSerializer;
		}
	>;
};

// ─── Extension factory ───────────────────────────────────────────────────────

/**
 * Create a one-way markdown materializer extension that writes table rows
 * to `.md` files on disk.
 *
 * Each configured table gets its own subdirectory under `config.directory`.
 * Rows are serialized to YAML frontmatter (plus optional markdown body) using
 * the configured serializer. File writes happen on initial materialization
 * and on every subsequent Y.Doc change via `table.observe()`.
 *
 * This is a **one-way projection** (Y.Doc → files). Changes to the `.md` files
 * on disk are not synced back. Files are intentionally left on disk when the
 * extension is disposed—they serve as a snapshot of the last known state.
 *
 * Register with `withWorkspaceExtension` (not `withExtension`) because the
 * factory needs access to `tables` from the workspace context.
 *
 * @param config - Root directory and per-table serializer configuration.
 * @returns An extension factory for use with `.withWorkspaceExtension()`.
 *
 * @example
 * ```typescript
 * import { markdownMaterializer } from '@epicenter/workspace/extensions/materializer/markdown';
 * import { titleFilenameSerializer } from '@epicenter/workspace/extensions/materializer/markdown';
 *
 * const workspace = createTabManagerWorkspace()
 *   .withExtension('persistence', filesystemPersistence({ ... }))
 *   .withWorkspaceExtension('markdown', markdownMaterializer({
 *     directory: './data',
 *     tables: {
 *       savedTabs: { serializer: titleFilenameSerializer('title') },
 *       bookmarks: { serializer: titleFilenameSerializer('title') },
 *       devices: {},
 *     },
 *   }))
 *   .withExtension('sync', createSyncExtension({ ... }));
 * ```
 */
export function markdownMaterializer(config: MarkdownMaterializerConfig) {
	return ({ tables }: ExtensionContext) => {
		const unsubscribers: Array<() => void> = [];

		const whenReady = (async () => {
			for (const [tableKey, tableConfig] of Object.entries(config.tables)) {
				const table = tables[tableKey];
				if (!table) continue;

				const dir = join(config.directory, tableConfig.directory ?? tableKey);

				const { error: mkdirError } = await tryAsync({
					try: () => mkdir(dir, { recursive: true }),
					catch: (error) => {
						console.warn(`[markdown-materializer] failed to create ${dir}:`, error);
						return Ok(undefined);
					},
				});
				// If mkdir failed, skip this table entirely — all writes would fail
				if (mkdirError) continue;

				const serializer = tableConfig.serializer ?? defaultSerializer();

				// Filename tracking for rename detection.
				// Captured by the observer closure below.
				const filenames = new Map<string, string>();

				// Initial materialization: write all current valid rows
				for (const row of table.getAllValid()) {
					const result = serializer.serialize(row as Record<string, unknown>);
					const { error: writeError } = await tryAsync({
						try: () => Bun.write(
							join(dir, result.filename),
							toMarkdown(result.frontmatter, result.body),
						),
						catch: (error) => {
							console.warn(`[markdown-materializer] failed to write ${result.filename}:`, error);
							return Ok(undefined);
						},
					});
					if (!writeError) filenames.set(String(row.id), result.filename);
				}

				// Observe ongoing changes
				const unsubscribe = table.observe((changedIds) => {
					const writes: Array<Promise<void>> = [];

					for (const id of changedIds) {
						const getResult = table.get(id);

						if (getResult.status === 'not_found') {
							const oldFilename = filenames.get(id);
							if (oldFilename) {
								writes.push(safeUnlink(join(dir, oldFilename)));
								filenames.delete(id);
							}
							continue;
						}

						if (getResult.status !== 'valid') continue;

						const row = getResult.row as Record<string, unknown>;
						const { frontmatter, body, filename } = serializer.serialize(row);

						// Rename detection: delete the old file if filename changed
						const oldFilename = filenames.get(id);
						if (oldFilename && oldFilename !== filename) {
							writes.push(safeUnlink(join(dir, oldFilename)));
						}

						writes.push(
							Bun.write(join(dir, filename), toMarkdown(frontmatter, body)),
						);
						filenames.set(id, filename);
					}

					// Best-effort — surface failures as warnings
					Promise.allSettled(writes).then((results) => {
						for (const r of results) {
							if (r.status === 'rejected') {
								console.warn('[markdown-materializer] write failed:', r.reason);
							}
						}
					});
				});

				unsubscribers.push(unsubscribe);
			}
		})();

		return {
			whenReady,
			dispose() {
				for (const unsubscribe of unsubscribers) {
					unsubscribe();
				}
			},
		};
	};
}
