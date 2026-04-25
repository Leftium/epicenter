/**
 * Fuji workspace client.
 *
 * `openFuji()` returns the bare workspace bundle (ydoc + tables + kv +
 * awareness + encryption + idb). App-specific layers — actions, sync, per-row
 * content cache — are sibling exports at module scope.
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

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

function openFuji() {
	const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, fujiTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	return {
		ydoc,
		tables,
		kv,
		awareness,
		encryption,
		idb,
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const fuji = openFuji();

export const actions = createFujiActions(fuji.tables);

export const sync = attachSync(fuji.ydoc, {
	url: toWsUrl(`${APP_URLS.API}/workspaces/${fuji.ydoc.guid}`),
	waitFor: fuji.idb.whenLoaded,
	awareness: fuji.awareness.raw,
	getToken: () => auth.getToken(),
	dispatch: (action, input) => dispatchAction(actions, action, input),
});

export const entryContentDocs = createDisposableCache(
	(entryId: EntryId) =>
		createEntryContentDoc({
			entryId,
			workspaceId: fuji.ydoc.guid,
			entriesTable: fuji.tables.entries,
			auth,
			apiUrl: APP_URLS.API,
		}),
	{ gcTime: 5_000 },
);

// Every session transition routes through this single subscription.
// Logout (previous !== null, next === null) wipes local data; login and
// token rotation (next !== null) re-apply encryption keys and re-arm sync.
// Cold-boot-anonymous is a silent no-op — neither branch runs.
auth.onSessionChange((next, previous) => {
	if (next === null) {
		sync.goOffline();
		if (previous !== null) void fuji.idb.clearLocal();
		return;
	}
	fuji.encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) sync.reconnect();
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
