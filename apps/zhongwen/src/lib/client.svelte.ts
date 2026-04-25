/**
 * Zhongwen workspace client.
 *
 * Browser-only chat app: IndexedDB persistence plus cross-tab BroadcastChannel
 * coordination. No server sync, no awareness.
 *
 * Module-scope flat exports — the file IS the workspace recipe, top-down.
 */

import { createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { session } from '$lib/auth';
import { zhongwenKv, zhongwenTables } from '$lib/workspace';

// ─── identity ──────────────────────────────────────────────────────────
export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

// ─── ydoc + state ──────────────────────────────────────────────────────
export const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
export const encryption = attachEncryption(ydoc);
export const tables = encryption.attachTables(ydoc, zhongwenTables);
export const kv = encryption.attachKv(ydoc, zhongwenKv);

// ─── storage ───────────────────────────────────────────────────────────
export const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

export const batch = (fn: () => void) => ydoc.transact(fn);
export const whenReady = idb.whenLoaded;

// ─── session lifecycle ─────────────────────────────────────────────────
auth.onSessionChange((next, previous) => {
	if (next === null) {
		if (previous !== null) void idb.clearLocal();
		return;
	}
	encryption.applyKeys(next.encryptionKeys);
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
