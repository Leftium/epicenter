/**
 * Zhongwen workspace client — a direct `openZhongwen()` call that owns
 * the Y.Doc construction and composes every attachment inline.
 *
 * Zhongwen is a browser-only chat app: IndexedDB persistence plus cross-tab
 * BroadcastChannel coordination. No server sync, no awareness.
 */

import { createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { session } from '$lib/auth';
import { zhongwenKv, zhongwenTables } from '$lib/workspace';

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

export function openZhongwen() {
	const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, zhongwenTables);
	const kv = encryption.attachKv(ydoc, zhongwenKv);

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	auth.onSessionChange((next, previous) => {
		if (next === null) {
			if (previous !== null) void idb.clearLocal();
			return;
		}
		encryption.applyKeys(next.encryptionKeys);
	});

	return {
		get id() {
			return ydoc.guid;
		},
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

export const workspace = openZhongwen();

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
