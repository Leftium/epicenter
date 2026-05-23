/**
 * Zhongwen browser composition.
 *
 * Single source of truth for "how Zhongwen mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via attachEncryption)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. reconnect listener for the root sync on auth transitions
 *
 * Zhongwen has no child docs and no daemon actions; the root doc is the
 * entire workspace surface. The bundle's `wipe()` drops every encrypted IDB
 * database for this subject; `Symbol.dispose` tears down the root Y.Doc
 * without touching local storage.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import type { SignedIn } from '@epicenter/svelte';
import {
	attachEncryption,
	attachLocalStorage,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { ZHONGWEN_ID, zhongwenKv, zhongwenTables } from '@epicenter/zhongwen';
import * as Y from 'yjs';

export function openZhongwenBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ydoc = new Y.Doc({ guid: ZHONGWEN_ID, gc: true });
	const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
	const tables = encryption.attachTables(zhongwenTables);
	const kv = encryption.attachKv(zhongwenKv);

	const idb = attachLocalStorage(ydoc, signedIn);
	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl(APP_URLS.API, ydoc.guid),
		openWebSocket: signedIn.auth.openWebSocket,
		waitFor: idb.whenLoaded,
		installationId,
		actions: {},
	});

	const unsubscribeAuth = signedIn.auth.onStateChange(() => {
		collaboration.reconnect();
	});

	return {
		ydoc,
		tables,
		kv,
		idb,
		collaboration,
		async wipe() {
			ydoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({ subject: signedIn.subject });
		},
		[Symbol.dispose]() {
			unsubscribeAuth();
			ydoc.destroy();
		},
	};
}

export type ZhongwenBrowser = ReturnType<typeof openZhongwenBrowser>;
