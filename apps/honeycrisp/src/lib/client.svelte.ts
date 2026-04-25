/**
 * Honeycrisp workspace client — a direct `openHoneycrisp()` call that
 * owns the Y.Doc construction and composes every attachment inline.
 *
 * Auth transitions drive every sync decision through a single
 * `auth.onSessionChange` subscription: login (re)applies encryption keys
 * and reconnects, logout clears local data, token rotation re-arms the
 * sync transport.
 */

import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
	attachSync,
	dispatchAction,
	toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createNoteBodyDocs } from '$lib/note-body-docs';
import { createHoneycrispActions, honeycrispTables } from '$lib/workspace';

const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

export function openHoneycrisp() {
	const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, honeycrispTables);
	const kv = encryption.attachKv(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const actions = createHoneycrispActions(tables);
	const sync = attachSync(ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
		getToken: () => auth.getToken(),
		dispatch: (action, input) => dispatchAction(actions, action, input),
	});

	const noteBodyDocs = createNoteBodyDocs({
		workspaceId: ydoc.guid,
		notesTable: tables.notes,
		auth,
	});

	auth.onSessionChange((next, previous) => {
		if (next === null) {
			sync.goOffline();
			if (previous !== null) void idb.clearLocal();
			return;
		}
		encryption.applyKeys(next.encryptionKeys);
		if (previous?.token !== next.token) sync.reconnect();
	});

	return {
		ydoc,
		tables,
		kv,
		encryption,
		idb,
		sync,
		actions,
		noteBodyDocs,
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const workspace = openHoneycrisp();
export const noteBodyDocs = workspace.noteBodyDocs;

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
