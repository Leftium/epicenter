/**
 * One-way markdown materializer for the opensidian workspace.
 *
 * Observes the files table, reads document content from per-file Y.Docs,
 * and writes `.md` files with YAML frontmatter (metadata) and markdown
 * body (document content). Wikilinks in the body are converted from
 * `epicenter://` epicenter links.
 *
 * This is opensidian-specific because the generic `markdownMaterializer`
 * only serializes table row data — it doesn't know about document content.
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { convertEpicenterLinksToWikilinks } from '@epicenter/workspace';
import { type FileRow } from '@epicenter/filesystem';
import { toMarkdown } from '@epicenter/workspace/extensions/materializer/markdown';
import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';

const MAX_SLUG_LENGTH = 50;

/** Build a human-readable filename: `{slugified-name}-{id}.md`, falling back to `{id}.md`. */
function toFilename(row: FileRow): string {
	const name = row.name?.replace(/\.md$/i, '');
	if (name && name.trim().length > 0) {
		const slug = slugify(name).slice(0, MAX_SLUG_LENGTH);
		return slug
			? filenamify(`${slug}-${row.id}.md`, { replacement: '-' })
			: `${row.id}.md`;
	}
	return `${row.id}.md`;
}

/** Delete a file, silently succeeding if it doesn't exist. */
const safeUnlink = (filePath: string) => unlink(filePath).catch(() => {});

/**
 * Minimal workspace context the opensidian materializer requires.
 *
 * Structurally typed so TypeScript verifies compatibility at the
 * `.withWorkspaceExtension()` call site without importing heavy generics.
 */
type MaterializerContext = {
	tables: {
		files: {
			getAllValid(): FileRow[];
			get(
				id: FileRow['id'],
			):
				| { status: 'valid'; row: FileRow }
				| { status: 'not_found' }
				| { status: 'invalid' };
			observe(
				callback: (changedIds: ReadonlySet<FileRow['id']>) => void,
			): () => void;
		};
	};
	documents: {
		files: {
			content: {
				open(id: FileRow['id']): Promise<{ read(): string | undefined }>;
			};
		};
	};
	whenReady: Promise<void>;
};

/**
 * Create a one-way markdown materializer for the opensidian workspace.
 *
 * For each file in the files table, reads the document content handle
 * and writes a `.md` file with YAML frontmatter and markdown body.
 * Observes the files table for real-time changes and re-materializes
 * on every update.
 *
 * @param config.directory - Root directory for markdown output. Files are
 *   written to `{directory}/files/`.
 *
 * @example
 * ```typescript
 * const workspace = createWorkspace(opensidianDefinition)
 *   .withWorkspaceExtension('markdown', createOpensidianMaterializer({
 *     directory: './data',
 *   }));
 * ```
 */
export function createOpensidianMaterializer({
	directory,
}: {
	directory: string;
}) {
	return ({ tables, documents, whenReady }: MaterializerContext) => {
		const filesDir = join(directory, 'files');
		const filenames = new Map<string, string>();
		const unsubscribers: Array<() => void> = [];

		/**
		 * Materialize a single file row to disk.
		 *
		 * Opens the document handle to read content, combines with row
		 * metadata as YAML frontmatter, and writes a `.md` file. Folders
		 * are skipped — only `type === 'file'` rows produce output.
		 */
		async function materializeFile(row: FileRow): Promise<void> {
			if (row.type === 'folder') return;

			let content: string | undefined;
			try {
				const handle = await documents.files.content.open(row.id);
				content = handle.read();
			} catch {
				// Content doc not yet available (sync pending) — write metadata only
			}

			const frontmatter: Record<string, unknown> = {
				id: row.id,
				name: row.name,
				parentId: row.parentId,
				size: row.size,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				trashedAt: row.trashedAt,
			};

			const filename = toFilename(row);

			// Rename detection: delete the old file if the filename changed
			const oldFilename = filenames.get(row.id);
			if (oldFilename && oldFilename !== filename) {
				await safeUnlink(join(filesDir, oldFilename));
			}

			const exportedContent =
				content !== undefined
					? convertEpicenterLinksToWikilinks(content)
					: content;

			await Bun.write(
				join(filesDir, filename),
				toMarkdown(frontmatter, exportedContent),
			);
			filenames.set(row.id, filename);
		}

		const materializeReady = (async () => {
			await whenReady;
			await mkdir(filesDir, { recursive: true });

			// Initial materialization of all existing files
			for (const row of tables.files.getAllValid()) {
				try {
					await materializeFile(row);
				} catch (error) {
					console.warn('[opensidian-markdown] initial write failed:', error);
				}
			}

			// Observe ongoing changes — document content changes trigger updatedAt
			// on the row (via onUpdate), which fires this observer.
			const unsubscribe = tables.files.observe((changedIds) => {
				const writes: Array<Promise<void>> = [];

				for (const id of changedIds) {
					const result = tables.files.get(id);

					if (result.status === 'not_found') {
						const oldFilename = filenames.get(id);
						if (oldFilename) {
							writes.push(safeUnlink(join(filesDir, oldFilename)));
							filenames.delete(id);
						}
						continue;
					}

					if (result.status !== 'valid') continue;
					writes.push(materializeFile(result.row));
				}

				Promise.allSettled(writes).then((results) => {
					for (const r of results) {
						if (r.status === 'rejected') {
							console.warn('[opensidian-markdown] write failed:', r.reason);
						}
					}
				});
			});

			unsubscribers.push(unsubscribe);
		})();

		return {
			whenReady: materializeReady,
			dispose() {
				for (const unsub of unsubscribers) unsub();
			},
		};
	};
}
