/**
 * One-way markdown materializer for the Fuji workspace.
 *
 * Observes the entries table, reads document content from per-entry Y.Docs,
 * and writes `.md` files with YAML frontmatter (metadata) and markdown
 * body (document content). Follows the same pattern as the opensidian
 * materializer in `playground/opensidian-e2e/materializer.ts`.
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { toMarkdown } from '@epicenter/workspace/extensions/materializer/markdown';
import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';

import type { Entry } from './workspace';

const MAX_SLUG_LENGTH = 50;

/** Build a human-readable filename: `{slugified-title}-{id}.md`, falling back to `{id}.md`. */
function toFilename(row: Entry): string {
	const title = row.title?.trim();
	if (title && title.length > 0) {
		const slug = slugify(title).slice(0, MAX_SLUG_LENGTH);
		return slug
			? filenamify(`${slug}-${row.id}.md`, { replacement: '-' })
			: `${row.id}.md`;
	}
	return `${row.id}.md`;
}

/** Delete a file, silently succeeding if it doesn't exist. */
const safeUnlink = (filePath: string) => unlink(filePath).catch(() => {});

/**
 * Minimal workspace context the fuji materializer requires.
 *
 * Structurally typed so TypeScript verifies compatibility at the
 * `.withWorkspaceExtension()` call site without importing heavy generics.
 */
type MaterializerContext = {
	tables: {
		entries: {
			getAllValid(): Entry[];
			get(
				id: Entry['id'],
			):
				| { status: 'valid'; row: Entry }
				| { status: 'not_found' }
				| { status: 'invalid' };
			observe(
				callback: (changedIds: ReadonlySet<Entry['id']>) => void,
			): () => void;
		};
	};
	documents: {
		entries: {
			content: {
				open(id: Entry['id']): Promise<{ read(): string | undefined }>;
			};
		};
	};
	whenReady: Promise<void>;
};

/**
 * Create a one-way markdown materializer for the Fuji workspace.
 *
 * For each entry in the entries table, reads the document content handle
 * and writes a `.md` file with YAML frontmatter and markdown body.
 * Observes the entries table for real-time changes and re-materializes
 * on every update.
 *
 * @param config.directory - Root directory for markdown output. Files are
 *   written to `{directory}/fuji/`.
 */
export function createFujiMaterializer({ directory }: { directory: string }) {
	return ({ tables, documents, whenReady }: MaterializerContext) => {
		const fujiDir = join(directory, 'fuji');
		const filenames = new Map<string, string>();
		const unsubscribers: Array<() => void> = [];

		/**
		 * Materialize a single entry row to disk.
		 *
		 * Opens the document handle to read content, combines with row
		 * metadata as YAML frontmatter, and writes a `.md` file.
		 */
		async function materializeEntry(row: Entry): Promise<void> {
			let content: string | undefined;
			try {
				const handle = await documents.entries.content.open(row.id);
				content = handle.read();
			} catch {
				// Content doc not yet available (sync pending)—write metadata only
			}

			const frontmatter: Record<string, unknown> = {
				id: row.id,
				title: row.title,
				subtitle: row.subtitle,
				type: row.type,
				tags: row.tags,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			};

			const filename = toFilename(row);

			// Rename detection: delete the old file if the filename changed
			const oldFilename = filenames.get(row.id);
			if (oldFilename && oldFilename !== filename) {
				await safeUnlink(join(fujiDir, oldFilename));
			}

			await Bun.write(
				join(fujiDir, filename),
				toMarkdown(frontmatter, content),
			);
			filenames.set(row.id, filename);
		}

		const materializeReady = (async () => {
			await whenReady;
			await mkdir(fujiDir, { recursive: true });

			// Initial materialization of all existing entries
			for (const row of tables.entries.getAllValid()) {
				try {
					await materializeEntry(row);
				} catch (error) {
					console.warn('[fuji-markdown] initial write failed:', error);
				}
			}

			// Observe ongoing changes—document content changes trigger updatedAt
			// on the row (via onUpdate), which fires this observer.
			const unsubscribe = tables.entries.observe((changedIds) => {
				const writes: Array<Promise<void>> = [];

				for (const id of changedIds) {
					const result = tables.entries.get(id);

					if (result.status === 'not_found') {
						const oldFilename = filenames.get(id);
						if (oldFilename) {
							writes.push(safeUnlink(join(fujiDir, oldFilename)));
							filenames.delete(id);
						}
						continue;
					}

					if (result.status !== 'valid') continue;
					writes.push(materializeEntry(result.row));
				}

				Promise.allSettled(writes).then((results) => {
					for (const r of results) {
						if (r.status === 'rejected') {
							console.warn('[fuji-markdown] write failed:', r.reason);
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
