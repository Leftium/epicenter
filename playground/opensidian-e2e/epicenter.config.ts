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
 * Composes a DocumentBundle by calling `attach*` primitives directly on a
 * Y.Doc. For a `defineDocument((id) => { ... }).open(id)` variant, see
 * `apps/whispering/src/lib/client.ts`.
 *
 * Usage:
 *   epicenter start playground/opensidian-e2e --verbose
 *   epicenter list files -C playground/opensidian-e2e
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createSessionStore, EPICENTER_PATHS } from '@epicenter/cli';
import { createFileContentDocs } from '@epicenter/filesystem';
import { opensidianTables } from 'opensidian/workspace';
import {
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
	attachSqlite,
	attachSync,
	defineMutation,
} from '@epicenter/workspace';
import {
	createMarkdownMaterializer,
	prepareMarkdownFiles,
	toMarkdown,
	toSlugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { createSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import Type from 'typebox';
import * as Y from 'yjs';

const SERVER_URL = process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const MATERIALIZER_DIR = join(import.meta.dir, '.epicenter', 'materializer');
mkdirSync(MATERIALIZER_DIR, { recursive: true });

const WORKSPACE_ID = 'opensidian';
const sessions = createSessionStore();

const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: false });
const encryption = attachEncryption(ydoc);
const tables = attachEncryptedTables(ydoc, encryption, opensidianTables);
const kv = attachEncryptedKv(ydoc, encryption, {});

const persistence = attachSqlite(ydoc, {
	filePath: EPICENTER_PATHS.persistence(WORKSPACE_ID),
});

// Inline the old `createCliUnlock`: load the session after persistence
// hydrates, then apply encryption keys from it (if any).
const whenUnlocked = (async () => {
	await persistence.whenLoaded;
	const session = await sessions.load(SERVER_URL);
	if (session?.encryptionKeys) {
		encryption.applyKeys(session.encryptionKeys);
	}
})();

const sync = attachSync(ydoc, {
	url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
	getToken: async () => (await sessions.load(SERVER_URL))?.accessToken ?? null,
	waitFor: Promise.all([persistence.whenLoaded, whenUnlocked]),
});

/**
 * Per-file content persistence via `attachSqlite`. Each content Y.Doc writes
 * its own `{guid}.db` under `~/.epicenter/persistence/{workspaceId}/content/`.
 * Survives restarts without relying on sync hydration.
 */
const CONTENT_DIR = join(
	EPICENTER_PATHS.home(),
	'persistence',
	WORKSPACE_ID,
	'content',
);
const fileContentDocs = createFileContentDocs({
	workspaceId: WORKSPACE_ID,
	filesTable: tables.files,
	attach: (contentDoc) =>
		attachSqlite(contentDoc, {
			filePath: join(CONTENT_DIR, `${contentDoc.guid}.db`),
		}),
});

async function readContent(id: string): Promise<string | undefined> {
	using handle = fileContentDocs.open(id);
	await handle.whenReady;
	return handle.content.read();
}

const whenReady = Promise.all([
	persistence.whenLoaded,
	whenUnlocked,
	sync.whenConnected,
]).then(() => {});

const markdown = createMarkdownMaterializer(
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

const sqlite = createSqliteMaterializer(
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

export const opensidian = {
	id: WORKSPACE_ID,
	ydoc,
	tables,
	kv,
	encryption,
	persistence,
	sync,
	markdown,
	sqlite,
	whenReady,
	whenDisposed: Promise.all([persistence.whenDisposed, sync.whenDisposed]).then(
		() => {},
	),
	actions: { markdown: markdownActions },
	[Symbol.dispose]() {
		ydoc.destroy();
	},
};

export { fileContentDocs };
