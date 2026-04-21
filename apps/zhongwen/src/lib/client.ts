/**
 * Zhongwen workspace client — a single `defineDocument` closure that owns the
 * Y.Doc construction and composes every attachment inline.
 *
 * Zhongwen is a browser-only chat app: IndexedDB persistence plus cross-tab
 * BroadcastChannel coordination. No server sync, no awareness.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineDocument,
} from '@epicenter/workspace';
import { createAuth } from '@epicenter/svelte/auth';
import {
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { session } from '$lib/auth';
import { zhongwenKv, zhongwenTables } from '$lib/workspace';

const zhongwen = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const encryption = attachEncryption(ydoc);
		const tables = attachEncryptedTables(ydoc, encryption, zhongwenTables);
		const kv = attachEncryptedKv(ydoc, encryption, zhongwenKv);

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
			whenDisposed: Promise.all([
				idb.whenDisposed,
				encryption.whenDisposed,
			]).then(() => {}),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: Number.POSITIVE_INFINITY },
);

export const workspace = zhongwen.open('epicenter.zhongwen');

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
