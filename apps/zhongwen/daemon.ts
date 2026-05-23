/**
 * Zhongwen daemon library default.
 *
 * `openZhongwenDaemon(ctx)` composes the daemon-side mount that any
 * Zhongwen-consuming project can use directly when they want library-default
 * paths. Zhongwen has no daemon actions and no materializers today; the
 * daemon's only job is to host the encrypted Y.Doc on disk and bridge sync.
 */

import { attachEncryption } from '@epicenter/workspace';
import type { DaemonWorkspaceContext } from '@epicenter/workspace/daemon';
import { attachDaemonInfrastructure } from '@epicenter/workspace/node';
import * as Y from 'yjs';
import { ZHONGWEN_ID, zhongwenKv, zhongwenTables } from './workspace.js';

export function openZhongwenDaemon({
	projectDir,
	yDocClientId,
	clientId,
	owner,
	keyring,
	openWebSocket,
	onAuthChange,
}: DaemonWorkspaceContext) {
	const ydoc = new Y.Doc({ guid: ZHONGWEN_ID, gc: true });
	ydoc.clientID = yDocClientId;
	const encryption = attachEncryption(ydoc, { keyring });
	encryption.attachTables(zhongwenTables);
	encryption.attachKv(zhongwenKv);

	return attachDaemonInfrastructure(ydoc, {
		projectDir,
		owner,
		clientId,
		openWebSocket,
		onAuthChange,
		actions: {},
	});
}

export type ZhongwenDaemon = ReturnType<typeof openZhongwenDaemon>;
