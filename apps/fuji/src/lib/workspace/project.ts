/**
 * Fuji project mount.
 *
 * `fuji(opts?)` returns the `Mount` that any project's `epicenter.config.ts`
 * default-exports. Default disk paths follow the library convention
 * (`.epicenter/sqlite/<id>.db`, `.epicenter/md/<id>/`); options let a project
 * override the markdown directory (typically to surface entries at the project
 * root) and the SQLite file.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via createFuji)
 *   2. SQLite materializer at `opts.sqliteFile ?? sqlitePath(...)`
 *   3. Markdown materializer at `opts.markdownDir ?? markdownPath(...)`; each
 *      entry's body is read on demand from its content doc, synced from the
 *      cloud per row and never persisted on the daemon
 *   4. infrastructure: Yjs log persistence + cloud sync via
 *      `attachProjectInfrastructure`
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachRichText,
	defineActions,
	defineWorkspace,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	type GitAutosaveConfig,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachProjectInfrastructure,
	markdownPath,
	resolveProjectPath,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import * as Y from 'yjs';
import { createFuji, type Entry, entryContentDocGuid } from './index.js';

const BODY_CONNECT_DEADLINE_MS = 10_000;

export type FujiMountOptions = {
	/** Markdown directory; relative paths resolve against `projectDir`. */
	markdownDir?: string;
	/** SQLite file path; relative paths resolve against `projectDir`. */
	sqliteFile?: string;
	/** Enable per-materializer Git autosave for markdown output. */
	git?: GitAutosaveConfig;
};

export function fuji(opts: FujiMountOptions = {}) {
	return defineMount({
		name: 'fuji',
		open(ctx) {
			const {
				projectDir,
				mount,
				yDocClientId,
				deviceId,
				ownerId,
				keyring,
				openWebSocket,
				onReconnectSignal,
			} = ctx;

			const workspace = createFuji({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile =
				resolveProjectPath(projectDir, opts.sqliteFile) ??
				sqlitePath(projectDir, workspace.ydoc.guid);
			const mdDir =
				resolveProjectPath(projectDir, opts.markdownDir) ??
				markdownPath(projectDir, workspace.ydoc.guid);

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile,
				log: createLogger(`${mount}-sqlite`),
			});
			/**
			 * Read one entry's body from its content doc. The body lives in a
			 * separate cloud doc addressed by `entryContentDocGuid(id)`; the daemon
			 * does not mirror it, so we open a throwaway doc, sync it, read the
			 * text, and destroy it. No local persistence: a body read is a read,
			 * not a second on-disk copy.
			 *
			 * Throws when the connect deadline elapses so the materializer skips the write and
			 * leaves the existing `.md` intact rather than clobbering it with an
			 * empty body.
			 */
			const readEntryBody = async (entry: Entry): Promise<string> => {
				const ydoc = new Y.Doc({
					guid: entryContentDocGuid(entry.id),
					gc: true,
				});
				const collaboration = openCollaboration(ydoc, {
					url: roomWsUrl({
						baseURL: EPICENTER_API_URL,
						ownerId,
						guid: ydoc.guid,
						deviceId,
					}),
					openWebSocket,
					onReconnectSignal,
					connectDeadlineMs: BODY_CONNECT_DEADLINE_MS,
					actions: {},
				});
				try {
					await collaboration.whenConnected;
					return attachRichText(ydoc).read();
				} finally {
					ydoc.destroy();
					await collaboration.whenDisposed;
				}
			};

			const markdown = attachMarkdownMaterializer(workspace, {
				dir: mdDir,
				log: createLogger(`${mount}-markdown`),
				perTable: {
					entries: {
						filename: slugFilename('title'),
						// `{ ...entry }` is the materializer's default frontmatter; this
						// callback exists only to attach the body read. The body is read
						// fresh every time the row changes: a daemon restart re-reads all
						// bodies, which self-heals any `.md` left stale by a cross-doc
						// sync race (root `updatedAt` arriving before the body update).
						toMarkdown: async (entry) => ({
							frontmatter: { ...entry },
							body: await readEntryBody(entry),
						}),
					},
				},
				git: opts.git,
			});

			const actions = defineActions({
				...workspace.actions,
				...sqlite.actions,
				...markdown.actions,
			});

			const infrastructure = attachProjectInfrastructure(workspace.ydoc, {
				baseURL: EPICENTER_API_URL,
				projectDir,
				ownerId,
				deviceId,
				openWebSocket,
				onReconnectSignal,
				actions,
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
				markdown,
				actions,
			});
		},
	});
}

export type FujiMount = ReturnType<typeof fuji>;
