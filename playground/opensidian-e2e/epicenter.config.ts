/**
 * OpenSidian workspace config — one-way materialization to markdown files.
 *
 * Syncs the OpenSidian workspace from the Epicenter API, persists the files
 * table to SQLite, and materializes each file as a `.md` on disk with YAML
 * frontmatter (metadata) and markdown body (document content).
 *
 * Reads auth credentials from the CLI session store at
 * `~/.epicenter/auth/sessions.json` — run `epicenter auth login` first.
 *
 * Usage:
 *   epicenter start playground/opensidian-e2e --verbose
 *   epicenter list files -C playground/opensidian-e2e
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionStore, resolveEpicenterHome } from '@epicenter/cli';
import { convertInternalLinksToWikilinks, type FileRow } from '@epicenter/filesystem';
import { persistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { toMarkdown } from '@epicenter/workspace/extensions/materializer/markdown';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';
import { createOpensidian } from 'opensidian/workspace';

const SERVER_URL = 'https://api.epicenter.so';
const PERSISTENCE_DIR = join(import.meta.dir, '.epicenter', 'persistence');
const MARKDOWN_DIR = join(import.meta.dir, 'data');

const sessions = createSessionStore(resolveEpicenterHome());

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Config ───────────────────────────────────────────────────────────────────

export const opensidian = createOpensidian()
	.withWorkspaceExtension('persistence', (ctx) =>
		persistence(ctx, {
			filePath: join(PERSISTENCE_DIR, 'opensidian.db'),
		}),
	)
	.withWorkspaceExtension('markdown', ({ tables, documents, whenReady }) => {
		const filesDir = join(MARKDOWN_DIR, 'files');
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

			const exportedContent = content !== undefined
				? convertInternalLinksToWikilinks(content)
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
	})
	.withWorkspaceExtension('unlock', ({ whenReady, applyEncryptionKeys }) => ({
		whenReady: (async () => {
			await whenReady;
			const session = await sessions.load(SERVER_URL);
			if (session?.encryptionKeys) {
				applyEncryptionKeys(session.encryptionKeys);
			}
		})(),
	}))
	.withExtension(
		'sync',
		createSyncExtension({
			url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
			getToken: async () => {
				const session = await sessions.load(SERVER_URL);
				return session?.accessToken ?? null;
			},
		}),
	);
