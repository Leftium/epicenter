/**
 * Fuji browser composition.
 *
 * Single source of truth for "how Fuji mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createFujiWorkspace)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. per-entry child docs (plaintext Y.XmlFragment + encrypted IDB storage)
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without
 * touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import {
	attachLocalStorage,
	attachRichText,
	createDisposableCache,
	DateTimeString,
	type DeviceId,
	onLocalUpdate,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import {
	createFujiActions,
	createFujiWorkspace,
	type EntryId,
	entryContentDocGuid,
} from './workspace';

export function openFujiBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createFujiWorkspace({ keyring: signedIn.keyring });
	const actions = createFujiActions(workspace);

	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});
	const collaboration = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: workspace.ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions,
	});

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const childYdoc = new Y.Doc({
			guid: entryContentDocGuid(entryId),
			gc: true,
		});
		const body = attachRichText(childYdoc);
		const childIdb = attachLocalStorage(childYdoc, {
			server: signedIn.server,
			ownerId: signedIn.ownerId,
			keyring: signedIn.keyring,
		});
		const childSync = openCollaboration(childYdoc, {
			url: roomWsUrl({
				baseURL: signedIn.baseURL,
				ownerId: signedIn.ownerId,
				guid: childYdoc.guid,
				deviceId,
			}),
			openWebSocket: signedIn.openWebSocket,
			onReconnectSignal: signedIn.onReconnectSignal,
			waitFor: childIdb.whenLoaded,
			actions: {},
		});

		onLocalUpdate(childYdoc, () => {
			workspace.tables.entries.update(entryId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc: childYdoc,
			body,
			idb: childIdb,
			sync: childSync,
			/**
			 * Child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				childYdoc.destroy();
			},
		};
	});

	return {
		...workspace,
		actions,
		idb,
		entryContentDocs,
		collaboration,
		async wipe() {
			entryContentDocs[Symbol.dispose]();
			workspace[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			workspace[Symbol.dispose]();
		},
	};
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
