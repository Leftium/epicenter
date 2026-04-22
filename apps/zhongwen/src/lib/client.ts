/**
 * Zhongwen workspace client — a direct `buildZhongwen(id)` call that owns
 * the Y.Doc construction and composes every attachment inline.
 *
 * Zhongwen is a browser-only chat app: IndexedDB persistence plus cross-tab
 * BroadcastChannel coordination. No server sync, no awareness.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
} from '@epicenter/workspace';
import { createAuth } from '@epicenter/svelte/auth';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { session } from '$lib/auth';
import { zhongwenKv, zhongwenTables } from '$lib/workspace';

export function buildZhongwen(id: string) {
	const ydoc = new Y.Doc({ guid: id, gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, zhongwenTables);
	const kv = encryption.attachKv(ydoc, zhongwenKv);

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	return {
		id,
		ydoc,
		tables,
		kv,
		encryption,
		idb,
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const workspace = buildZhongwen('epicenter.zhongwen');

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.encryption.applyKeys(session.encryptionKeys);
	},
	async onLogout() {
		await workspace.idb.clearLocal();
		window.location.reload();
	},
});
