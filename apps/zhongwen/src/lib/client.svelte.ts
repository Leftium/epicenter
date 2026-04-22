/**
 * Zhongwen workspace client — a direct `openZhongwen()` call that owns
 * the Y.Doc construction and composes every attachment inline.
 *
 * Zhongwen is a browser-only chat app: IndexedDB persistence plus cross-tab
 * BroadcastChannel coordination. No server sync, no awareness.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
} from '@epicenter/workspace';
import type { AuthSession } from '@epicenter/svelte/auth';
import { createAuth } from '@epicenter/svelte/auth';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { session } from '$lib/auth';
import { zhongwenKv, zhongwenTables } from '$lib/workspace';

export function openZhongwen() {
	const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, zhongwenTables);
	const kv = encryption.attachKv(ydoc, zhongwenKv);

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	// Edge detector: only wipe IDB on a genuine logged-in → logged-out transition.
	// Cold-start-unauth (first call, `previous` still null) must be a noop so
	// anonymous data isn't destroyed at boot.
	let previousSession: AuthSession | null = null;
	async function applySession(next: AuthSession | null) {
		const wasAuthed = previousSession !== null;
		previousSession = next;
		if (next === null) {
			if (wasAuthed) await idb.clearLocal();
			return;
		}
		encryption.applyKeys(next.encryptionKeys);
	}

	return {
		get id() {
			return ydoc.guid;
		},
		ydoc,
		tables,
		kv,
		encryption,
		idb,
		applySession,
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const workspace = openZhongwen();

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
