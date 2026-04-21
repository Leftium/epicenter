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
} from '@epicenter/document';
import { createAuth } from '@epicenter/svelte/auth';
import {
	attachEncryption,
	attachKv,
	attachTables,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { session } from '$lib/auth';
import { zhongwenKv, zhongwenTables } from '$lib/workspace';

const zhongwen = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const tables = attachTables(ydoc, zhongwenTables);
		const kv = attachKv(ydoc, zhongwenKv);
		const enc = attachEncryption(ydoc, { tables, kv });

		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);

		return {
			id,
			ydoc,
			tables: tables.helpers,
			kv: kv.helper,
			enc,
			idb,
			batch: (fn: () => void) => ydoc.transact(fn),
			whenReady: idb.whenLoaded,
			whenDisposed: Promise.all([
				idb.whenDisposed,
				enc.whenDisposed,
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
		workspace.enc.applyKeys(session.encryptionKeys);
	},
	async onLogout() {
		await workspace.idb.clearLocal();
		window.location.reload();
	},
});
