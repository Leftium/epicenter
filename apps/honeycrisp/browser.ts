/**
 * Honeycrisp browser composition.
 *
 * Single source of truth for "how Honeycrisp mounts in a browser." Calls
 * Tier 1 primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via openEncryptedDoc)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. per-note rich-text body sub-docs (plaintext Y.XmlFragment + encrypted IDB)
 *  4. reconnect listener for the root and every live child sync
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this subject;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without touching
 * local storage.
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
	createHoneycrispActions,
	HONEYCRISP_ID,
	honeycrispTables,
	type NoteId,
	noteBodyDocGuid,
} from './workspace';

export function openHoneycrispBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ws = openEncryptedDoc({ id: HONEYCRISP_ID, keyring: signedIn.keyring });
	const tables = ws.attachTables(honeycrispTables);
	const kv = ws.attachKv({});
	const actions = createHoneycrispActions(tables);

	const idb = attachLocalStorage(ws.ydoc, signedIn);
	const collaboration = openCollaboration(ws.ydoc, {
		url: roomWsUrl(APP_URLS.API, ws.ydoc.guid),
		openWebSocket: signedIn.auth.openWebSocket,
		waitFor: idb.whenLoaded,
		installationId,
		actions,
	});

	const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
		const ydoc = new Y.Doc({ guid: noteBodyDocGuid(noteId), gc: true });
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
			tables.notes.update(noteId, {
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

	// Auth transitions: tell live sockets to retry.
	// Sign-in: a previously-rejected socket reconnects with the new token.
	// Sign-out: the server closes the existing socket on its own (4401);
	//   reconnect() ensures the supervisor doesn't sit in 'failed' if the
	//   user signs back in.
	const unsubscribeAuth = signedIn.auth.onStateChange(() => {
		collaboration.reconnect();
		for (const child of noteBodyDocs.values()) {
			child.sync.reconnect();
		}
	});

	return {
		ydoc: ws.ydoc,
		tables,
		kv,
		actions,
		idb,
		noteBodyDocs,
		collaboration,
		async wipe() {
			noteBodyDocs[Symbol.dispose]();
			ws[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({ subject: signedIn.subject });
		},
		[Symbol.dispose]() {
			unsubscribeAuth();
			noteBodyDocs[Symbol.dispose]();
			ws[Symbol.dispose]();
		},
	};
}

export type HoneycrispBrowser = ReturnType<typeof openHoneycrispBrowser>;
