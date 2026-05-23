/**
 * Honeycrisp daemon library default.
 *
 * `openHoneycrispDaemon(ctx)` composes the daemon-side mount that any
 * Honeycrisp-consuming project can use directly when they want library-default
 * paths.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via openEncryptedDoc)
 *   2. SQLite materializer at `sqlitePath(projectDir, workspaceId)` for
 *      folders + notes
 *   3. Markdown materializer at `markdownPath(projectDir, workspaceId)` for
 *      notes
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
	createHoneycrispActions,
	HONEYCRISP_ID,
	honeycrispTables,
} from './workspace.js';

export function openHoneycrispDaemon(ctx: DaemonWorkspaceContext) {
	const ws = openEncryptedDoc({
		id: HONEYCRISP_ID,
		keyring: ctx.keyring,
		clientId: ctx.clientId,
	});
	const tables = ws.attachTables(honeycrispTables);
	ws.attachKv({});
	const actions = createHoneycrispActions(tables);

	const sqliteDb = openWriterSqlite({
		filePath: sqlitePath(ctx.projectDir, ws.ydoc.guid),
		log: createLogger(`${ctx.route}-sqlite`),
	});
	ws.ydoc.once('destroy', () => sqliteDb.close());

	const sqlite = attachSqliteMaterializer(ws.ydoc, { db: sqliteDb });
	sqlite.table(tables.folders);
	sqlite.table(tables.notes);

	attachMarkdownMaterializer(ws.ydoc, {
		dir: markdownPath(ctx.projectDir, ws.ydoc.guid),
	}).table(tables.notes, { filename: slugFilename('title') });

	return attachDaemonInfrastructure(ws.ydoc, {
		projectDir: ctx.projectDir,
		openWebSocket: ctx.openWebSocket,
		installationId: ctx.installationId,
		actions,
	});
}

export type HoneycrispDaemon = ReturnType<typeof openHoneycrispDaemon>;
