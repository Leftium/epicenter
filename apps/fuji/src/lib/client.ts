/**
 * Fuji workspace client — single Y.Doc instance with IndexedDB persistence,
 * encryption, and WebSocket sync (with built-in BroadcastChannel cross-tab sync).
 *
 * Access tables via `workspace.tables.entries`. The client is ready when
 * `workspace.whenReady` resolves.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	toWsUrl,
} from '@epicenter/document';
import { createPersistedState } from '@epicenter/svelte';
import { AuthSession, createAuth } from '@epicenter/svelte/auth';
import { createFujiActions, fuji } from '$lib/workspace';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

const base = fuji.open('epicenter.fuji');
const idb = attachIndexedDb(base.ydoc);
attachBroadcastChannel(base.ydoc);
const sync = attachSync(base.ydoc, {
	url: (workspaceId) => toWsUrl(`${APP_URLS.API}/workspaces/${workspaceId}`),
	getToken: async () => auth.token,
	waitFor: idb.whenLoaded,
});

export const workspace = Object.assign(base, {
	id: 'epicenter.fuji',
	idb,
	sync,
	actions: createFujiActions(base.tables),
	whenReady: idb.whenLoaded,
});

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
