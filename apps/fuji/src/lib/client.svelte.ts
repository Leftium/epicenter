/**
 * Fuji workspace client.
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
	attachAwareness,
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
	attachSync,
	createDisposableCache,
	dispatchAction,
	toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createEntryContentDoc } from '$lib/entry-content-docs';
import { createFujiActions, fujiTables, type EntryId } from '$lib/workspace';

// ─── identity ──────────────────────────────────────────────────────────
const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

// ─── ydoc + state ──────────────────────────────────────────────────────
export const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
export const encryption = attachEncryption(ydoc);
export const tables = encryption.attachTables(ydoc, fujiTables);
export const kv = encryption.attachKv(ydoc, {});
export const awareness = attachAwareness(ydoc, {});

// ─── storage ───────────────────────────────────────────────────────────
export const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

// ─── per-row content cache ─────────────────────────────────────────────
export const entryContentDocs = createDisposableCache(
	(entryId: EntryId) =>
		createEntryContentDoc({
			entryId,
			workspaceId: ydoc.guid,
			entriesTable: tables.entries,
			auth,
			apiUrl: APP_URLS.API,
		}),
	{ gcTime: 5_000 },
);

// ─── actions + sync ────────────────────────────────────────────────────
export const actions = createFujiActions(tables);

export const sync = attachSync(ydoc, {
	url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
	waitFor: idb.whenLoaded,
	awareness: awareness.raw,
	getToken: () => auth.getToken(),
	dispatch: (action, input) => dispatchAction(actions, action, input),
});

export const batch = (fn: () => void) => ydoc.transact(fn);
export const whenReady = idb.whenLoaded;

// ─── session lifecycle ─────────────────────────────────────────────────
// Every session transition routes through this single subscription.
// Logout (previous !== null, next === null) wipes local data; login and
// token rotation (next !== null) re-apply encryption keys and re-arm sync.
// Cold-boot-anonymous is a silent no-op — neither branch runs.
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
