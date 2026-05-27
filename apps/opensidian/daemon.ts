/**
 * Opensidian daemon library default.
 *
 * `openOpensidianDaemon(ctx)` composes the daemon-side mount that any
 * Opensidian-consuming project can use directly when they want library-default
 * paths.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via createOpensidianWorkspace)
 *   2. infrastructure: Yjs log persistence + cloud sync via
 *      `attachDaemonInfrastructure`
 *
 * The shared workspace currently exposes no daemon actions. Opensidian's file
 * and shell actions need browser services (Yjs filesystem, in-browser SQLite,
 * just-bash) and are added only by the browser runtime.
 */

import { defineWorkspaceBundle } from '@epicenter/workspace';
import type { DaemonWorkspaceContext } from '@epicenter/workspace/daemon';
import { attachDaemonInfrastructure } from '@epicenter/workspace/node';
import { createOpensidianWorkspace } from './workspace.js';

export function openOpensidianDaemon({
	projectDir,
	yDocClientId,
	deviceId,
	ownerId,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: DaemonWorkspaceContext) {
	const workspace = createOpensidianWorkspace({ keyring });
	workspace.ydoc.clientID = yDocClientId;

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

export type OpensidianDaemon = ReturnType<typeof openOpensidianDaemon>;
