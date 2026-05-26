/**
 * Fuji daemon library default.
 *
 * `openFujiDaemon(ctx)` composes the daemon-side mount that any
 * Fuji-consuming project can use directly when they want library-default
 * paths. The canonical `examples/fuji` project uses the project-layout spec
 * paths inline rather than calling this; see `examples/fuji/epicenter.config.ts`.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via createFujiWorkspace)
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
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachDaemonInfrastructure,
	markdownPath,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { createFujiActions, createFujiWorkspace } from './src/lib/workspace.js';

export function openFujiDaemon({
	projectDir,
	route,
	yDocClientId,
	deviceId,
	ownerId,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: DaemonWorkspaceContext) {
	const workspace = createFujiWorkspace({ keyring });
	workspace.ydoc.clientID = yDocClientId;
	const actions = createFujiActions(workspace);

	attachBunSqliteMaterializer(workspace, {
		filePath: sqlitePath(projectDir, workspace.ydoc.guid),
		log: createLogger(`${route}-sqlite`),
	});
	attachMarkdownMaterializer(workspace, {
		dir: markdownPath(projectDir, workspace.ydoc.guid),
		perTable: { entries: { filename: slugFilename('title') } },
	});

	return attachDaemonInfrastructure(workspace.ydoc, {
		projectDir,
		ownerId,
		deviceId,
		openWebSocket,
		onReconnectSignal,
		actions,
	});
}

export type FujiDaemon = ReturnType<typeof openFujiDaemon>;
