/**
 * Zhongwen daemon library default.
 *
 * `openZhongwenDaemon(ctx)` composes the daemon-side mount that any
 * Zhongwen-consuming project can use directly when they want library-default
 * paths. Zhongwen has no daemon actions and no materializers today; the
 * daemon's only job is to host the encrypted Y.Doc on disk and bridge sync.
 */

import { defineWorkspaceBundle } from '@epicenter/workspace';
import type { DaemonWorkspaceContext } from '@epicenter/workspace/daemon';
import { attachDaemonInfrastructure } from '@epicenter/workspace/node';
import { createZhongwenWorkspace } from './workspace.js';

export function openZhongwenDaemon({
	projectDir,
	yDocClientId,
	deviceId,
	ownerId,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: DaemonWorkspaceContext) {
	const workspace = createZhongwenWorkspace({ keyring });
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

export type ZhongwenDaemon = ReturnType<typeof openZhongwenDaemon>;
