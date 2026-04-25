/**
 * Zhongwen workspace — module-scope inline composition.
 *
 * Browser-only chat app: IndexedDB persistence plus cross-tab BroadcastChannel
 * coordination. No server sync, no awareness.
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
const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, zhongwenTables);
const kv = encryption.attachKv(ydoc, zhongwenKv);

// ─── storage ───────────────────────────────────────────────────────────
const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

// ─── session lifecycle ─────────────────────────────────────────────────
auth.onSessionChange((next, previous) => {
	if (next === null) {
		if (previous !== null) void idb.clearLocal();
		return;
	}
	encryption.applyKeys(next.encryptionKeys);
});

// ─── export ────────────────────────────────────────────────────────────
export const zhongwen = {
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

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
