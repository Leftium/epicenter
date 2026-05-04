/**
 * Opensidian workspace playground: one-way materialization to markdown files
 * and a queryable SQLite mirror with FTS5 full-text search.
 *
 * Syncs the Opensidian workspace from the Epicenter API, persists the workspace
 * Y.Doc to SQLite, materializes each file row as a `.md` on disk with YAML
 * frontmatter (metadata) and markdown body (document content), and mirrors
 * the files table into a queryable SQLite database with FTS5 indexing.
 *
 * Reads auth credentials from the CLI session store at
 * `~/.epicenter/auth/sessions.json`. Run `epicenter auth login` first.
 *
 * Hosts the `opensidian` route as a full daemon peer: actions, sync,
 * presence, RPC, and disposal. Daemon action paths are relative to `actions`.
 *
 * Usage:
 *   # Run the workspace. Imports this config, which constructs the
 *   # workspace, starting persistence + sync + markdown + SQLite materialization.
 *   # Runs until Ctrl+C.
 *   bun run playground/opensidian-e2e/epicenter.config.ts
 *
 *   # Invoke the markdown.prepare mutation.
 *   epicenter run opensidian.markdown.prepare '{"directory":"./some/dir"}' \
 *     -C playground/opensidian-e2e
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFileContentDoc } from '@epicenter/filesystem';
import {
	attachEncryption,
	attachSync,
	createDisposableCache,
	defineMutation,
	toWsUrl,
} from '@epicenter/workspace';
import { defineEpicenterConfig } from '@epicenter/workspace/daemon';
import { attachSqlite } from '@epicenter/workspace/document/attach-sqlite';
import {
	attachMarkdownMaterializer,
	prepareMarkdownFiles,
	toSlugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachSessionUnlock,
	createSessionStore,
	epicenterPaths,
} from '@epicenter/workspace/node';
import { opensidianTables } from 'opensidian/workspace';
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
const tables = encryption.attachTables(ydoc, opensidianTables);
const kv = encryption.attachKv(ydoc, {});

const persistence = attachSqlite(ydoc, {
	filePath: epicenterPaths.persistence(WORKSPACE_ID),
});

const unlock = attachSessionUnlock(encryption, {
	sessions,
	serverUrl: SERVER_URL,
	waitFor: persistence.whenLoaded,
});

const sync = attachSync(ydoc, {
	url: toWsUrl(`${SERVER_URL}/workspaces/${ydoc.guid}`),
	waitFor: Promise.all([persistence.whenLoaded, unlock.whenChecked]),
	getToken: async () => (await sessions.load(SERVER_URL))?.accessToken ?? null,
});

/**
 * Per-file content persistence via `attachSqlite`. Each content Y.Doc writes
 * its own `{guid}.db` under `~/.epicenter/persistence/{workspaceId}/content/`.
 * Survives restarts without relying on sync hydration.
 */
const CONTENT_DIR = join(
	epicenterPaths.home(),
	'persistence',
	WORKSPACE_ID,
	'content',
);
const fileContentDocs = createDisposableCache(
	(fileId: string) =>
		createFileContentDoc({
			fileId: fileId as never,
			workspaceId: WORKSPACE_ID,
			filesTable: tables.files,
			attachPersistence: (contentDoc) =>
				attachSqlite(contentDoc, {
					filePath: join(CONTENT_DIR, `${contentDoc.guid}.db`),
				}),
		}),
	{ gcTime: 5_000 },
);

async function readContent(rowId: string): Promise<string | undefined> {
	await using handle = fileContentDocs.open(rowId);
	await handle.whenReady;
	return handle.content.read();
}

const whenReady = Promise.all([
	persistence.whenLoaded,
	unlock.whenChecked,
	sync.whenConnected,
]);

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
const actions = {
	markdown: {
		prepare: defineMutation({
			title: 'Prepare Markdown Files',
			description:
				'Add unique IDs to markdown files missing them in YAML frontmatter',
			input: Type.Object({ directory: Type.String() }),
			handler: async ({ directory }) => prepareMarkdownFiles(directory),
		}),
	},
};
const presence = sync.attachPresence({
	peer: {
		id: 'opensidian-playground-daemon',
		name: 'Opensidian Playground Daemon',
		platform: 'node',
	},
});
const rpc = sync.attachRpc(actions);

export const opensidian = {
	workspaceId: ydoc.guid,
	whenReady,
	actions,
	sync,
	presence,
	rpc,
	[Symbol.dispose]() {
		ydoc.destroy();
	},
	// Extras for direct script use, not part of the hosted daemon runtime contract.
	id: WORKSPACE_ID,
	ydoc,
	tables,
	kv,
	encryption,
	persistence,
	fileContentDocs,
	markdown,
	sqlite,
};

export default defineEpicenterConfig({
	daemon: {
		routes: {
			opensidian: () => opensidian,
		},
	},
});
