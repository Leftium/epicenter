/**
 * Opensidian workspace playground — one-way materialization to markdown files
 * and a queryable SQLite mirror with FTS5 full-text search.
 *
 * Syncs the Opensidian workspace from the Epicenter API, persists the workspace
 * Y.Doc to SQLite, materializes each file row as a `.md` on disk with YAML
 * frontmatter (metadata) and markdown body (document content), and mirrors
 * the files table into a queryable SQLite database with FTS5 indexing.
 *
 * Reads auth credentials from the CLI session store at
 * `~/.epicenter/auth/sessions.json` — run `epicenter auth login` first.
 *
 * Composes a DocumentBundle via `defineDocument((id) => ...).open(id)` so the
 * handle carries the `DOCUMENT_HANDLE` brand that `loadConfig` checks for.
 *
 * Usage:
 *   epicenter start playground/opensidian-e2e --verbose
 *   epicenter list files -C playground/opensidian-e2e
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
	attachSessionUnlock,
	createSessionStore,
	EPICENTER_PATHS,
} from '@epicenter/cli';
import { createFileContentDocs } from '@epicenter/filesystem';
import { opensidianTables } from 'opensidian/workspace';
import {
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
	attachSqlite,
	attachSync,
	defineDocument,
	defineMutation,
} from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	prepareMarkdownFiles,
	toMarkdown,
	toSlugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import Type from 'typebox';
import * as Y from 'yjs';

const SERVER_URL = process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const MATERIALIZER_DIR = join(import.meta.dir, '.epicenter', 'materializer');
mkdirSync(MATERIALIZER_DIR, { recursive: true });

const WORKSPACE_ID = 'opensidian';
const sessions = createSessionStore();

const opensidianFactory = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id, gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = attachEncryptedTables(ydoc, encryption, opensidianTables);
	const kv = attachEncryptedKv(ydoc, encryption, {});

	const persistence = attachSqlite(ydoc, {
		filePath: EPICENTER_PATHS.persistence(id),
	});

	const unlock = attachSessionUnlock(encryption, {
		sessions,
		serverUrl: SERVER_URL,
		waitFor: persistence.whenLoaded,
	});

	const sync = attachSync(ydoc, {
		url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
		getToken: async () =>
			(await sessions.load(SERVER_URL))?.accessToken ?? null,
		waitFor: Promise.all([persistence.whenLoaded, unlock.whenApplied]),
	});

	/**
	 * Per-file content persistence via `attachSqlite`. Each content Y.Doc writes
	 * its own `{guid}.db` under `~/.epicenter/persistence/{workspaceId}/content/`.
	 * Survives restarts without relying on sync hydration.
	 */
	const CONTENT_DIR = join(
		EPICENTER_PATHS.home(),
		'persistence',
		id,
		'content',
	);
	const fileContentDocs = createFileContentDocs({
		workspaceId: id,
		filesTable: tables.files,
		attach: (contentDoc) =>
			attachSqlite(contentDoc, {
				filePath: join(CONTENT_DIR, `${contentDoc.guid}.db`),
			}),
	});

	async function readContent(rowId: string): Promise<string | undefined> {
		using handle = fileContentDocs.open(rowId);
		await handle.whenReady;
		return handle.content.read();
	}

	const whenReady = Promise.all([
		persistence.whenLoaded,
		unlock.whenApplied,
		sync.whenConnected,
	]).then(() => {});

	const markdown = attachMarkdownMaterializer(
		{ tables, kv, whenReady },
		{ dir: MARKDOWN_DIR },
	).table('files', {
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
				// Content doc not yet available (sync pending).
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
	});

	const sqlite = attachSqliteMaterializer(
		{ tables, definitions: opensidianTables, whenReady },
		{ db: new Database(join(MATERIALIZER_DIR, 'opensidian.db')) },
	).table('files', { fts: ['name'] });

	/**
	 * Scan a directory for `.md` files and inject a unique `id` into the YAML
	 * frontmatter of any file that doesn't already have one. Errors if duplicate
	 * IDs are detected across files.
	 */
	const markdownActions = {
		prepare: defineMutation({
			title: 'Prepare Markdown Files',
			description:
				'Add unique IDs to markdown files missing them in YAML frontmatter',
			input: Type.Object({ directory: Type.String() }),
			handler: async ({ directory }) => prepareMarkdownFiles(directory),
		}),
	};

	return {
		id,
		ydoc,
		tables,
		kv,
		encryption,
		persistence,
		sync,
		fileContentDocs,
		markdown,
		sqlite,
		whenReady,
		whenDisposed: Promise.all([
			persistence.whenDisposed,
			sync.whenDisposed,
		]).then(() => {}),
		actions: { markdown: markdownActions },
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

export const opensidian = opensidianFactory.open(WORKSPACE_ID);
