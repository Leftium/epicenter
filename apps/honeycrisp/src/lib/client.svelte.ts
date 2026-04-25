/**
 * Honeycrisp workspace client.
 *
 * Module-scope flat exports — the file IS the workspace recipe, top-down.
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

// ─── identity ──────────────────────────────────────────────────────────
const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

// ─── ydoc + state ──────────────────────────────────────────────────────
export const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
export const encryption = attachEncryption(ydoc);
export const tables = encryption.attachTables(ydoc, honeycrispTables);
export const kv = encryption.attachKv(ydoc, {});

// ─── storage ───────────────────────────────────────────────────────────
export const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

// ─── per-row content cache ─────────────────────────────────────────────
export const noteBodyDocs = createDisposableCache(
	(noteId: NoteId) =>
		createNoteBodyDoc({
			noteId,
			workspaceId: ydoc.guid,
			notesTable: tables.notes,
			auth,
			apiUrl: APP_URLS.API,
		}),
	{ gcTime: 5_000 },
);

// ─── actions + sync ────────────────────────────────────────────────────
export const actions = createHoneycrispActions(tables);

export const sync = attachSync(ydoc, {
	url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
	waitFor: idb.whenLoaded,
	getToken: () => auth.getToken(),
	dispatch: (action, input) => dispatchAction(actions, action, input),
});

export const batch = (fn: () => void) => ydoc.transact(fn);
export const whenReady = idb.whenLoaded;

// ─── session lifecycle ─────────────────────────────────────────────────
auth.onSessionChange((next, previous) => {
	if (next === null) {
		sync.goOffline();
		if (previous !== null) void idb.clearLocal();
		return;
	}
	encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) sync.reconnect();
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
