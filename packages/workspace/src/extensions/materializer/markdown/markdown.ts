import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { YAML } from 'bun';
import { convertEpicenterLinksToWikilinks } from '../../../links.js';
import type { ExtensionContext } from '../../../workspace/types.js';
import { defaultSerializer, type MarkdownSerializer } from './serializers.js';

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * Assemble a markdown string from YAML frontmatter and an optional body.
 *
 * Pure function — no I/O. Uses `Bun.YAML.stringify` for spec-compliant
 * serialization (handles quoting of booleans, numeric strings, special
 * characters, newlines, etc.). Undefined frontmatter values are stripped
 * (missing key); null values are preserved (YAML `null`) so nullable
 * fields survive a future round-trip.
 */
export function toMarkdown(
	frontmatter: Record<string, unknown>,
	body?: string,
): string {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value !== undefined) {
			cleaned[key] = value;
		}
	}
	const yaml = YAML.stringify(cleaned, null, 2);
	const yamlBlock = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
	return body !== undefined
		? `---\n${yamlBlock}---\n\n${body}\n`
		: `---\n${yamlBlock}---\n`;
}

/** Delete a file, silently succeeding if it doesn't exist or can't be removed. */
const safeUnlink = (filePath: string) => unlink(filePath).catch(() => {});

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

				try {
					await mkdir(dir, { recursive: true });
				} catch (error) {
					console.warn(
						`[markdown-materializer] failed to create ${dir}:`,
						error,
					);
					continue;
				}

				const serializer = tableConfig.serializer ?? defaultSerializer();

				// Filename tracking for rename detection.
				// Captured by the observer closure below.
				const filenames = new Map<string, string>();

				// Initial materialization: write all current valid rows
				for (const row of table.getAllValid()) {
					const result = serializer.serialize(row as Record<string, unknown>);
					try {
						const processedBody =
							result.body !== undefined
								? convertEpicenterLinksToWikilinks(result.body)
								: result.body;
						await Bun.write(
							join(dir, result.filename),
							toMarkdown(result.frontmatter, processedBody),
						);
						filenames.set(row.id as string, result.filename);
					} catch (error) {
						console.warn(
							`[markdown-materializer] failed to write ${result.filename}:`,
							error,
						);
					}
				}

				// Observe ongoing changes
				const unsubscribe = table.observe((changedIds) => {
					const writes: Array<Promise<unknown>> = [];

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

						const processedBody =
							body !== undefined
								? convertEpicenterLinksToWikilinks(body)
								: body;

						writes.push(
							Bun.write(
								join(dir, filename),
								toMarkdown(frontmatter, processedBody),
							),
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
