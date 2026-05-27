/**
 * Honeycrisp daemon library default.
 *
 * `openHoneycrispDaemon(ctx)` composes the daemon-side mount that any
 * Honeycrisp-consuming project can use directly when they want library-default
 * paths.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via createHoneycrispWorkspace)
 *   2. SQLite materializer at `sqlitePath(projectDir, workspaceId)` for
 *      folders + notes
 *   3. Markdown materializer at `markdownPath(projectDir, workspaceId)` for
 *      notes
 *   4. infrastructure: Yjs log persistence + cloud sync via
 *      `attachDaemonInfrastructure`
 */

import { defineWorkspaceBundle } from '@epicenter/workspace';
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
import { createHoneycrispWorkspace } from './workspace.js';

export function openHoneycrispDaemon({
	projectDir,
	route,
	yDocClientId,
	deviceId,
	ownerId,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: DaemonWorkspaceContext) {
	const workspace = createHoneycrispWorkspace({ keyring });
	workspace.ydoc.clientID = yDocClientId;

	attachBunSqliteMaterializer(workspace, {
		filePath: sqlitePath(projectDir, workspace.ydoc.guid),
		log: createLogger(`${route}-sqlite`),
	});

	attachMarkdownMaterializer(workspace, {
		dir: markdownPath(projectDir, workspace.ydoc.guid),
		perTable: { notes: { filename: slugFilename('title') } },
	});

	const infrastructure = attachDaemonInfrastructure(workspace.ydoc, {
		projectDir,
		ownerId,
		deviceId,
		openWebSocket,
		onReconnectSignal,
		actions: workspace.actions,
	});

	return defineWorkspaceBundle({
		...workspace,
		...infrastructure,
	});
}

export type HoneycrispDaemon = ReturnType<typeof openHoneycrispDaemon>;
