/**
 * Honeycrisp workspace client.
 *
 * `openHoneycrisp()` returns the bare workspace bundle (ydoc + tables + kv +
 * encryption + idb). App-specific layers — actions, sync, per-note body cache —
 * are sibling exports at module scope.
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
	createDisposableCache,
	dispatchAction,
	toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createNoteBodyDoc } from '$lib/note-body-docs';
import {
	createHoneycrispActions,
	honeycrispTables,
	type NoteId,
} from '$lib/workspace';

const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

function openHoneycrisp() {
	const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, honeycrispTables);
	const kv = encryption.attachKv(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	return {
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

export const honeycrisp = openHoneycrisp();

export const actions = createHoneycrispActions(honeycrisp.tables);

export const sync = attachSync(honeycrisp.ydoc, {
	url: toWsUrl(`${APP_URLS.API}/workspaces/${honeycrisp.ydoc.guid}`),
	waitFor: honeycrisp.idb.whenLoaded,
	getToken: () => auth.getToken(),
	dispatch: (action, input) => dispatchAction(actions, action, input),
});

export const noteBodyDocs = createDisposableCache(
	(noteId: NoteId) =>
		createNoteBodyDoc({
			noteId,
			workspaceId: honeycrisp.ydoc.guid,
			notesTable: honeycrisp.tables.notes,
			auth,
			apiUrl: APP_URLS.API,
		}),
	{ gcTime: 5_000 },
);

auth.onSessionChange((next, previous) => {
	if (next === null) {
		sync.goOffline();
		if (previous !== null) void honeycrisp.idb.clearLocal();
		return;
	}
	honeycrisp.encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) sync.reconnect();
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
