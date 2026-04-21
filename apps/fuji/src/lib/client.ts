/**
 * Fuji workspace client — a single `defineDocument` closure that owns the
 * Y.Doc construction and composes every attachment inline.
 *
 * This app collapses the old split between `defineWorkspace(schema)` and
 * `client.ts` composition into one closure. The bundle shape is whatever
 * we return — no framework convention, no `Object.assign` dance.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	defineDocument,
	toWsUrl,
} from '@epicenter/document';
import { createPersistedState } from '@epicenter/svelte';
import { AuthSession, createAuth } from '@epicenter/svelte/auth';
import {
	attachEncryption,
	attachKv,
	attachTables,
} from '@epicenter/workspace';
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

		const tables = attachTables(ydoc, fujiTables);
		const kv = attachKv(ydoc, {});
		const awareness = attachAwareness(ydoc, {});
		const enc = attachEncryption(ydoc, {
			stores: [...tables.stores, kv.store],
		});

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
			tables: tables.helpers,
			kv: kv.helper,
			awareness,
			enc,
			idb,
			sync,
			actions: createFujiActions(tables.helpers),
			batch: (fn: () => void) => ydoc.transact(fn),
			whenReady: idb.whenLoaded,
			whenDisposed: Promise.all([
				idb.whenDisposed,
				sync.whenDisposed,
				enc.whenDisposed,
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
		workspace.enc.applyKeys(session.encryptionKeys);
		workspace.sync.reconnect();
	},
	async onLogout() {
		await workspace.idb.clearLocal();
		window.location.reload();
	},
});
