/**
 * Fuji workspace client — a direct builder call that owns the Y.Doc
 * construction and composes every attachment inline.
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
	dispatchAction,
	toWsUrl,
	type Document,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createEntryContentDocs } from '$lib/entry-content-docs';
import { createFujiActions, fujiTables } from '$lib/workspace';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

export function openFuji() {
	const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, fujiTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const actions = createFujiActions(tables);
	const sync = attachSync(ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
		awareness: awareness.raw,
		getToken: () => auth.getToken(),
		dispatch: (action, input) => dispatchAction(actions, action, input),
	});

	const entryContentDocs = createEntryContentDocs({
		workspaceId: ydoc.guid,
		entriesTable: tables.entries,
		auth,
	});

	// Every session transition routes through this single subscription.
	// Logout (previous !== null, next === null) wipes local data; login and
	// token rotation (next !== null) re-apply encryption keys and re-arm sync.
	// Cold-boot-anonymous is a silent no-op — neither branch runs.
	// Token sourcing is pulled by `attachSync` via the `getToken` callback;
	// reconnect() forces it to pick up the latest token.
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
		awareness,
		encryption,
		idb,
		sync,
		actions,
		entryContentDocs,
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	} satisfies Document;
}

export const workspace = openFuji();
export const entryContentDocs = workspace.entryContentDocs;

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
