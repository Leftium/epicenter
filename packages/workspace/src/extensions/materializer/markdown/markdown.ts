import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionContext } from '../../../workspace/types.js';
import { deleteMarkdownFile, writeMarkdownFile } from './io.js';
import { defaultSerializer, type MarkdownSerializer } from './serializers.js';

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
				await mkdir(dir, { recursive: true });

				const serializer = tableConfig.serializer ?? defaultSerializer();

				// Filename tracking for rename detection.
				// Captured by the observer closure below.
				const filenames = new Map<string, string>();

				// Initial materialization: write all current valid rows
				const rows = table.getAllValid();
				for (const row of rows) {
					const result = serializer.serialize(row as Record<string, unknown>);
					await writeMarkdownFile(
						join(dir, result.filename),
						result.frontmatter,
						result.body,
					);
					filenames.set(String(row.id), result.filename);
				}

				// Set up observer for ongoing changes
				const unsubscribe = table.observe((changedIds) => {
					// Process the entire batch synchronously to avoid interleaving.
					// Fire-and-forget the async writes—observers are synchronous.
					const writes: Array<Promise<void>> = [];

					for (const id of changedIds) {
						const getResult = table.get(id);

						if (getResult.status === 'not_found') {
							const oldFilename = filenames.get(id);
							if (oldFilename) {
								writes.push(deleteMarkdownFile(join(dir, oldFilename)));
								filenames.delete(id);
							}
							continue;
						}

						if (getResult.status !== 'valid') continue;

						const row = getResult.row as Record<string, unknown>;
						const { frontmatter, body, filename } = serializer.serialize(row);

						// Detect rename: if the filename changed, delete the old file
						const oldFilename = filenames.get(id);
						if (oldFilename && oldFilename !== filename) {
							writes.push(deleteMarkdownFile(join(dir, oldFilename)));
						}

						writes.push(
							writeMarkdownFile(join(dir, filename), frontmatter, body),
						);
						filenames.set(id, filename);
					}

					// Surface failures as warnings—the materializer is
					// best-effort, not critical path.
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
