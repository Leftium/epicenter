/**
 * Fuji workspace client — a single `defineDocument` closure that owns the
 * Y.Doc construction and composes every attachment inline.
 *
 * This app collapses schema-and-composition into one closure. The bundle
 * shape is whatever we return — no framework convention, no `Object.assign`
 * dance.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	defineDocument,
	toWsUrl,
} from '@epicenter/workspace';
import { createPersistedState } from '@epicenter/svelte';
import { AuthSession, createAuth } from '@epicenter/svelte/auth';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createFujiActions, fujiTables } from '$lib/workspace';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

const fuji = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const encryption = attachEncryption(ydoc);
		const tables = encryption.attachTables(ydoc, fujiTables);
		const kv = encryption.attachKv(ydoc, {});
		const awareness = attachAwareness(ydoc, {});

		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);
		const sync = attachSync(ydoc, {
			url: (docId) => toWsUrl(`${APP_URLS.API}/workspaces/${docId}`),
			getToken: async () => auth.token,
			waitFor: idb.whenLoaded,
			awareness: awareness.raw,
		});

		return {
			id,
			ydoc,
			tables,
			kv,
			awareness,
			encryption,
			idb,
			sync,
			actions: createFujiActions(tables),
			batch: (fn: () => void) => ydoc.transact(fn),
			whenReady: idb.whenLoaded,
			whenDisposed: Promise.all([
				idb.whenDisposed,
				sync.whenDisposed,
				encryption.whenDisposed,
			]).then(() => {}),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: Number.POSITIVE_INFINITY },
);

export const workspace = fuji.open('epicenter.fuji');

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.encryption.applyKeys(session.encryptionKeys);
		workspace.sync.reconnect();
	},
	async onLogout() {
		await workspace.idb.clearLocal();
		window.location.reload();
	},
});
