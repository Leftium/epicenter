/**
 * Honeycrisp workspace client — a direct `buildHoneycrisp(id)` call that
 * owns the Y.Doc construction and composes every attachment inline.
 *
 * Access tables via `workspace.tables.folders` / `workspace.tables.notes`
 * and KV settings via `workspace.kv`. The client is ready when
 * `workspace.whenReady` resolves.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	toWsUrl,
} from '@epicenter/workspace';
import { createPersistedState } from '@epicenter/svelte';
import { AuthSession, createAuth } from '@epicenter/svelte/auth';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createHoneycrispActions, honeycrispTables } from '$lib/workspace';

const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export function buildHoneycrisp(id: string) {
	const ydoc = new Y.Doc({ guid: id, gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, honeycrispTables);
	const kv = encryption.attachKv(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const sync = attachSync(ydoc, {
		url: (docId) => toWsUrl(`${APP_URLS.API}/workspaces/${docId}`),
		getToken: async () => auth.token,
		waitFor: idb.whenLoaded,
	});

	return {
		id,
		ydoc,
		tables,
		kv,
		encryption,
		idb,
		sync,
		actions: createHoneycrispActions(tables),
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const workspace = buildHoneycrisp('epicenter.honeycrisp');

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
