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
 *   3. Markdown materializer at `opts.markdownDir ?? markdownPath(...)`
 *   4. infrastructure: Yjs log persistence + cloud sync via
 *      `attachProjectInfrastructure`
 */

import {
	attachRichText,
	defineActions,
	defineWorkspace,
} from '@epicenter/workspace';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
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
import * as Y from 'yjs';
import { createLogger } from 'wellcrafted/logger';
import {
	createFuji,
	entryContentDocGuid,
	type Entry,
	type EntryId,
} from './index.js';

const BODY_CONNECT_TIMEOUT_MS = 10_000;

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
			const entryBodies = new Map<EntryId, string>();
			let resolveInitialBodies!: () => void;
			const whenInitialBodies = new Promise<void>((resolve) => {
				resolveInitialBodies = resolve;
			});
			const markdown = attachMarkdownMaterializer(workspace, {
				dir: mdDir,
				waitFor: whenInitialBodies,
				perTable: {
					entries: {
						filename: slugFilename('title'),
						toMarkdown: (entry) => ({
							frontmatter: { ...entry },
							body: entryBodies.get(entry.id) ?? '',
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

			const bodyLog = createLogger(`${mount}-entry-bodies`);
			void (async () => {
				try {
					await withTimeout(
						infrastructure.collaboration.whenConnected,
						BODY_CONNECT_TIMEOUT_MS,
						`${workspace.ydoc.guid} root collaboration`,
					);
					for (const entry of workspace.tables.entries.getAllValid()) {
						const text = await readEntryBody({
							entry,
							baseURL: EPICENTER_API_URL,
							projectDir,
							ownerId,
							deviceId,
							openWebSocket,
							onReconnectSignal,
						}).catch((cause) => {
							bodyLog.warn(
								new Error(`Failed to materialize entry body ${entry.id}`, {
									cause,
								}),
							);
							return undefined;
						});
						if (text !== undefined) entryBodies.set(entry.id, text);
					}
				} catch (cause) {
					bodyLog.warn(
						new Error('Failed to materialize Fuji entry bodies', { cause }),
					);
				} finally {
					resolveInitialBodies();
				}
			})();

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

async function readEntryBody({
	entry,
	baseURL,
	projectDir,
	ownerId,
	deviceId,
	openWebSocket,
	onReconnectSignal,
}: {
	entry: Entry;
	baseURL: string;
	projectDir: Parameters<typeof attachProjectInfrastructure>[1]['projectDir'];
	ownerId: Parameters<typeof attachProjectInfrastructure>[1]['ownerId'];
	deviceId: Parameters<typeof attachProjectInfrastructure>[1]['deviceId'];
	openWebSocket: Parameters<
		typeof attachProjectInfrastructure
	>[1]['openWebSocket'];
	onReconnectSignal: Parameters<
		typeof attachProjectInfrastructure
	>[1]['onReconnectSignal'];
}): Promise<string> {
	const ydoc = new Y.Doc({ guid: entryContentDocGuid(entry.id), gc: true });
	const infrastructure = attachProjectInfrastructure(ydoc, {
		baseURL,
		projectDir,
		ownerId,
		deviceId,
		openWebSocket,
		onReconnectSignal,
		actions: {},
	});

	try {
		await withTimeout(
			infrastructure.collaboration.whenConnected,
			BODY_CONNECT_TIMEOUT_MS,
			`${ydoc.guid} body collaboration`,
		);
		return attachRichText(ydoc).read();
	} finally {
		await infrastructure[Symbol.asyncDispose]();
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				reject(new Error(`${label} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		}),
	]).finally(() => {
		if (timeout !== undefined) clearTimeout(timeout);
	});
}
