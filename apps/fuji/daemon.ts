/**
 * Fuji daemon library default.
 *
 * `openFujiDaemon(ctx)` composes the daemon-side mount that any
 * Fuji-consuming project can use directly when they want library-default
 * paths. The canonical `examples/fuji` project uses the project-layout spec
 * paths inline rather than calling this; see `examples/fuji/epicenter.config.ts`.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via openEncryptedDoc)
 *   2. SQLite materializer at `sqlitePath(projectDir, workspaceId)`
 *   3. Markdown materializer at `markdownPath(projectDir, workspaceId)`
 *   4. infrastructure: Yjs log persistence + cloud sync via
 *      `attachDaemonInfrastructure`
 */

import type { DaemonWorkspaceContext } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachDaemonInfrastructure,
	markdownPath,
	openWriterSqlite,
	sqlitePath,
} from '@epicenter/workspace/node';
import { openEncryptedDoc } from '@epicenter/workspace';
import { createLogger } from 'wellcrafted/logger';
import {
	createFujiActions,
	FUJI_ID,
	fujiTables,
} from './src/lib/workspace.js';

export function openFujiDaemon(ctx: DaemonWorkspaceContext) {
	const ws = openEncryptedDoc({
		id: FUJI_ID,
		keyring: ctx.keyring,
		clientId: ctx.clientId,
	});
	const tables = ws.attachTables(fujiTables);
	ws.attachKv({});
	const actions = createFujiActions(tables);

	const sqliteDb = openWriterSqlite({
		filePath: sqlitePath(ctx.projectDir, ws.ydoc.guid),
		log: createLogger(`${ctx.route}-sqlite`),
	});
	ws.ydoc.once('destroy', () => sqliteDb.close());

	attachSqliteMaterializer(ws.ydoc, { db: sqliteDb }).table(tables.entries);
	attachMarkdownMaterializer(ws.ydoc, {
		dir: markdownPath(ctx.projectDir, ws.ydoc.guid),
	}).table(tables.entries, { filename: slugFilename('title') });

	return attachDaemonInfrastructure(ws.ydoc, {
		projectDir: ctx.projectDir,
		openWebSocket: ctx.openWebSocket,
		installationId: ctx.installationId,
		actions,
	});
}

export type FujiDaemon = ReturnType<typeof openFujiDaemon>;
