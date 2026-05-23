/**
 * Zhongwen daemon library default.
 *
 * `openZhongwenDaemon(ctx)` composes the daemon-side mount that any
 * Zhongwen-consuming project can use directly when they want library-default
 * paths. Zhongwen has no daemon actions and no materializers today; the
 * daemon's only job is to host the encrypted Y.Doc on disk and bridge sync.
 */

import type { DaemonWorkspaceContext } from '@epicenter/workspace/daemon';
import { attachDaemonInfrastructure } from '@epicenter/workspace/node';
import { openEncryptedDoc } from '@epicenter/workspace';
import { ZHONGWEN_ID, zhongwenKv, zhongwenTables } from './workspace.js';

export function openZhongwenDaemon(ctx: DaemonWorkspaceContext) {
	const ws = openEncryptedDoc({
		id: ZHONGWEN_ID,
		keyring: ctx.keyring,
		clientId: ctx.clientId,
	});
	ws.attachTables(zhongwenTables);
	ws.attachKv(zhongwenKv);

	return attachDaemonInfrastructure(ws.ydoc, {
		projectDir: ctx.projectDir,
		openWebSocket: ctx.openWebSocket,
		installationId: ctx.installationId,
		actions: {},
	});
}

export type ZhongwenDaemon = ReturnType<typeof openZhongwenDaemon>;
