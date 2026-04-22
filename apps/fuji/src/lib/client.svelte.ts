/**
 * Fuji workspace client — a direct builder call that owns the Y.Doc
 * construction and composes every attachment inline.
 *
 * `openFuji()` returns the full bundle; call it once at module scope to
 * get the app's singleton workspace. The bundle exposes `applySession` so
 * every auth transition is a single method call, not a pair of callbacks
 * reaching across the client/workspace boundary.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	toWsUrl,
} from '@epicenter/workspace';
import { createPersistedState } from '@epicenter/svelte';
import { AuthSession, createAuth } from '@epicenter/svelte/auth';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createFujiActions, fujiTables } from '$lib/workspace';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export function openFuji() {
	const id = 'epicenter.fuji';
	const ydoc = new Y.Doc({ guid: id, gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, fujiTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const sync = attachSync(ydoc, {
		url: (docId) => toWsUrl(`${APP_URLS.API}/workspaces/${docId}`),
		waitFor: idb.whenLoaded,
		awareness: awareness.raw,
		requiresToken: true,
	});

	// Edge detector: only wipe IDB on a genuine logged-in → logged-out transition.
	// Cold-start-unauth (first call, `previous` still null) must be a noop so
	// anonymous data isn't destroyed at boot.
	let previousSession: AuthSession | null = null;
	async function applySession(next: AuthSession | null) {
		const wasAuthed = previousSession !== null;
		previousSession = next;
		if (next === null) {
			sync.goOffline();
			sync.setToken(null);
			if (wasAuthed) await idb.clearLocal();
			return;
		}
		encryption.applyKeys(next.encryptionKeys);
		sync.setToken(next.token);
		sync.reconnect();
	}

	return {
		id,
		ydoc,
		tables,
		kv,
		awareness,
		encryption,
		idb,
		sync,
		actions: createFujiActions(tables),
		applySession,
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const workspace = openFuji();

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

const dispose = $effect.root(() => {
	$effect(() => {
		void workspace.applySession(auth.session);
	});
});
if (import.meta.hot) import.meta.hot.dispose(dispose);
