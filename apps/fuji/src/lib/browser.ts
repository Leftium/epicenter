/**
 * Fuji browser composition.
 *
 * Single source of truth for "how Fuji mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via openEncryptedDoc)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. per-entry child docs (plaintext Y.XmlFragment + encrypted IDB storage)
 *  4. reconnect listener for the root and every live child sync
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this subject;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without
 * touching local storage.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import type { SignedIn } from '@epicenter/svelte';
import {
	attachLocalStorage,
	attachRichText,
	createDisposableCache,
	DateTimeString,
	onLocalUpdate,
	openCollaboration,
	openEncryptedDoc,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import {
	createFujiActions,
	type EntryId,
	entryContentDocGuid,
	FUJI_ID,
	fujiTables,
} from './workspace';

export function openFujiBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ws = openEncryptedDoc({ id: FUJI_ID, keyring: signedIn.keyring });
	const tables = ws.attachTables(fujiTables);
	const kv = ws.attachKv({});
	const actions = createFujiActions(tables);

	const idb = attachLocalStorage(ws.ydoc, signedIn);
	const collaboration = openCollaboration(ws.ydoc, {
		url: roomWsUrl(APP_URLS.API, ws.ydoc.guid),
		openWebSocket: signedIn.auth.openWebSocket,
		waitFor: idb.whenLoaded,
		installationId,
		actions,
	});

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const ydoc = new Y.Doc({ guid: entryContentDocGuid(entryId), gc: true });
		const body = attachRichText(ydoc);
		const childIdb = attachLocalStorage(ydoc, signedIn);
		const childSync = openCollaboration(ydoc, {
			url: roomWsUrl(APP_URLS.API, ydoc.guid),
			openWebSocket: signedIn.auth.openWebSocket,
			waitFor: childIdb.whenLoaded,
			installationId,
			actions: {},
		});

		onLocalUpdate(ydoc, () => {
			tables.entries.update(entryId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc,
			body,
			idb: childIdb,
			sync: childSync,
			/**
			 * Child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});

	const unsubscribeAuth = signedIn.auth.onStateChange(() => {
		collaboration.reconnect();
		for (const child of entryContentDocs.values()) {
			child.sync.reconnect();
		}
	});

	return {
		ydoc: ws.ydoc,
		tables,
		kv,
		actions,
		idb,
		entryContentDocs,
		collaboration,
		async wipe() {
			entryContentDocs[Symbol.dispose]();
			ws[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({ subject: signedIn.subject });
		},
		[Symbol.dispose]() {
			unsubscribeAuth();
			entryContentDocs[Symbol.dispose]();
			ws[Symbol.dispose]();
		},
	};
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
