/**
 * Honeycrisp workspace — module-scope inline composition.
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
const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, honeycrispTables);
const kv = encryption.attachKv(ydoc, {});

// ─── storage + transport ───────────────────────────────────────────────
const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);
const actions = createHoneycrispActions(tables);
const sync = attachSync(ydoc, {
	url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
	waitFor: idb.whenLoaded,
	getToken: () => auth.getToken(),
	dispatch: (action, input) => dispatchAction(actions, action, input),
});

// ─── per-row content docs ──────────────────────────────────────────────
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

// ─── export ────────────────────────────────────────────────────────────
export const honeycrisp = {
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

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
