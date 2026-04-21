/**
 * Opensidian workspace config — one-way materialization to markdown files
 * and queryable SQLite mirror with FTS5 full-text search.
 *
 * Syncs the Opensidian workspace from the Epicenter API, persists the files
 * table to SQLite, materializes each file as a `.md` on disk with YAML
 * frontmatter (metadata) and markdown body (document content), and mirrors
 * the files table into a queryable SQLite database with FTS5 indexing.
 *
 * Reads auth credentials from the CLI session store at
 * `~/.epicenter/auth/sessions.json` — run `epicenter auth login` first.
 *
 * Usage:
 *   epicenter start playground/opensidian-e2e --verbose
 *   epicenter list files -C playground/opensidian-e2e
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
	createCliUnlock,
	createSessionStore,
	EPICENTER_PATHS,
} from '@epicenter/cli';
import { attachSqlite } from '@epicenter/workspace';
import { createFileContentDocs } from '@epicenter/filesystem';
import { createWorkspace, defineMutation } from '@epicenter/workspace';
import {
	createMarkdownMaterializer,
	prepareMarkdownFiles,
	toMarkdown,
	toSlugFilename,
} from '@epicenter/workspace/extensions/materializer/markdown';
import { createSqliteMaterializer } from '@epicenter/workspace/extensions/materializer/sqlite';
import { sqlitePersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
import { opensidianDefinition } from 'opensidian/workspace';
import Type from 'typebox';

const SERVER_URL = process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const MATERIALIZER_DIR = join(import.meta.dir, '.epicenter', 'materializer');
mkdirSync(MATERIALIZER_DIR, { recursive: true });

const sessions = createSessionStore();

const base = createWorkspace(opensidianDefinition).withExtension(
	'persistence',
	sqlitePersistence({
		filePath: EPICENTER_PATHS.persistence(opensidianDefinition.id),
	}),
);

/**
 * Per-file content persistence via `attachSqlite`. Each content Y.Doc writes
 * its own `{guid}.db` under `~/.epicenter/persistence/{workspaceId}/content/`.
 * Survives restarts without relying on sync hydration.
 */
const CONTENT_DIR = join(
	EPICENTER_PATHS.home(),
	'persistence',
	base.id,
	'content',
);
const fileContentDocs = createFileContentDocs({
	workspaceId: base.id,
	filesTable: base.tables.files,
	attach: (ydoc) =>
		attachSqlite(ydoc, { filePath: join(CONTENT_DIR, `${ydoc.guid}.db`) }),
});

async function readContent(id: string): Promise<string | undefined> {
	using handle = fileContentDocs.open(id);
	await handle.whenReady;
	return handle.content.read();
}

export const opensidian = base
	.withExtension('materializer', (ctx) =>
		createMarkdownMaterializer(ctx, { dir: MARKDOWN_DIR }).table('files', {
			serialize: async (row) => {
				if (row.type === 'folder') {
					return {
						filename: `${row.id}.md`,
						content: toMarkdown({ id: row.id, name: row.name, type: 'folder' }),
					};
				}
				let content: string | undefined;
				try {
					content = await readContent(row.id);
				} catch {
					// Content doc not yet available (sync pending)
				}
				return {
					filename: toSlugFilename(row.name.replace(/\.md$/i, ''), row.id),
					content: toMarkdown(
						{
							id: row.id,
							name: row.name,
							parentId: row.parentId,
							size: row.size,
							createdAt: row.createdAt,
							updatedAt: row.updatedAt,
							trashedAt: row.trashedAt,
						},
						content,
					),
				};
			},
		}),
	)
	.withExtension('sqlite', (ctx) =>
		createSqliteMaterializer(ctx, {
			db: new Database(join(MATERIALIZER_DIR, 'opensidian.db')),
		}).table('files', { fts: ['name'] }),
	)
	.withExtension('unlock', createCliUnlock(sessions, SERVER_URL))
	.withExtension(
		'sync',
		createSyncExtension({
			url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
			getToken: async () => {
				const session = await sessions.load(SERVER_URL);
				return session?.accessToken ?? null;
			},
		}),
	)
	.withActions(() => ({
		/**
		 * Scan a directory for `.md` files and inject a unique `id` into the YAML
		 * frontmatter of any file that doesn't already have one. Errors if duplicate
		 * IDs are detected across files.
		 */
		markdown: {
			prepare: defineMutation({
				title: 'Prepare Markdown Files',
				description:
					'Add unique IDs to markdown files missing them in YAML frontmatter',
				input: Type.Object({ directory: Type.String() }),
				handler: async ({ directory }) => prepareMarkdownFiles(directory),
			}),
		},
	}));

export { fileContentDocs };
