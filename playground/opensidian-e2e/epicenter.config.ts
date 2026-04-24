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
 * Composes a DocumentBundle via `createDocumentFactory((id) => ...).open(id)` so the
 * handle carries the `DOCUMENT_HANDLE` brand that `loadConfig` checks for.
 *
 * Usage:
 *   # Run the workspace — imports this config, which opens the handle,
 *   # which starts persistence + sync + markdown + SQLite materialization.
 *   # Runs until Ctrl+C.
 *   bun run playground/opensidian-e2e/epicenter.config.ts
 *
 *   # Invoke the defined `markdownActions.prepare` mutation.
 *   epicenter run opensidian.markdownActions.prepare '{"directory":"./some/dir"}' \
 *     -C playground/opensidian-e2e
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
	attachSessionUnlock,
	createSessionStore,
	epicenterPaths,
} from '@epicenter/cli';
import { createFileContentDocs } from '@epicenter/filesystem';
import { opensidianTables } from 'opensidian/workspace';
import {
	attachEncryption,
	attachSqlite,
	attachSync,
	createDocumentFactory,
	defineMutation,
} from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	prepareMarkdownFiles,
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

const opensidianFactory = createDocumentFactory((id: string) => {
	const ydoc = new Y.Doc({ guid: id, gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, opensidianTables);
	const kv = encryption.attachKv(ydoc, {});

	const persistence = attachSqlite(ydoc, {
		filePath: epicenterPaths.persistence(id),
	});

	const unlock = attachSessionUnlock(encryption, {
		sessions,
		serverUrl: SERVER_URL,
		waitFor: persistence.whenLoaded,
	});

	const sync = attachSync(ydoc, {
		url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
		waitFor: Promise.all([persistence.whenLoaded, unlock.whenChecked]),
	});
	void (async () => {
		const loaded = await sessions.load(SERVER_URL);
		sync.setToken(loaded?.accessToken ?? null);
		sync.reconnect();
	})();

	/**
	 * Per-file content persistence via `attachSqlite`. Each content Y.Doc writes
	 * its own `{guid}.db` under `~/.epicenter/persistence/{workspaceId}/content/`.
	 * Survives restarts without relying on sync hydration.
	 */
	const CONTENT_DIR = join(
		epicenterPaths.home(),
		'persistence',
		id,
		'content',
	);
	const fileContentDocs = createFileContentDocs({
		workspaceId: id,
		filesTable: tables.files,
		attachPersistence: (contentDoc) =>
			attachSqlite(contentDoc, {
				filePath: join(CONTENT_DIR, `${contentDoc.guid}.db`),
			}),
	});

	async function readContent(rowId: string): Promise<string | undefined> {
		await using handle = fileContentDocs.open(rowId);
		await handle.whenReady;
		return handle.content.read();
	}

	const whenReady = Promise.all([
		persistence.whenLoaded,
		unlock.whenChecked,
		sync.whenConnected,
	]).then(() => {});

	const markdown = attachMarkdownMaterializer(ydoc, {
		dir: MARKDOWN_DIR,
		waitFor: whenReady,
	}).table(tables.files, {
		filename: (row) =>
			row.type === 'folder'
				? `${row.id}.md`
				: toSlugFilename(row.name.replace(/\.md$/i, ''), row.id),
		toMarkdown: async (row) => {
			if (row.type === 'folder') {
				return {
					frontmatter: { id: row.id, name: row.name, type: 'folder' },
					body: undefined,
				};
			}
			let body: string | undefined;
			try {
				body = await readContent(row.id);
			} catch {
				// Content doc not yet available (sync pending).
			}
			return {
				frontmatter: {
					id: row.id,
					name: row.name,
					parentId: row.parentId,
					size: row.size,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt,
					trashedAt: row.trashedAt,
				},
				body,
			};
		},
	});

	const sqlite = attachSqliteMaterializer(ydoc, {
		db: new Database(join(MATERIALIZER_DIR, 'opensidian.db')),
		waitFor: whenReady,
	}).table(tables.files, { fts: ['name'] });

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
		markdownActions,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

export const opensidian = opensidianFactory.open(WORKSPACE_ID);
