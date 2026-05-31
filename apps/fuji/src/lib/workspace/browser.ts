/**
 * Fuji browser composition.
 *
 * Single source of truth for "how Fuji mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createFuji)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. app-owned, typed body cache for per-entry child docs
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without touching
 * local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import {
	attachLocalStorage,
	attachRichText,
	type ActionRegistry,
	createDisposableCache,
	DateTimeString,
	type DeviceId,
	defineWorkspace,
	onLocalUpdate,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createFuji, entryContentDocGuid, type EntryId } from './index';
import { createFujiMarkdownActions } from './markdown';

export function openFujiBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createFuji({ keyring: signedIn.keyring });

	const wire = <TActions extends ActionRegistry>(
		ydoc: Y.Doc,
		actions: TActions,
	) => {
		const idb = attachLocalStorage(ydoc, {
			server: signedIn.server,
			ownerId: signedIn.ownerId,
			keyring: signedIn.keyring,
		});
		const collaboration = openCollaboration(ydoc, {
			url: roomWsUrl({
				baseURL: signedIn.baseURL,
				ownerId: signedIn.ownerId,
				guid: ydoc.guid,
				deviceId,
			}),
			openWebSocket: signedIn.openWebSocket,
			onReconnectSignal: signedIn.onReconnectSignal,
			waitFor: idb.whenLoaded,
			actions,
		});
		return { idb, collaboration };
	};

	const { idb, collaboration } = wire(workspace.ydoc, workspace.actions);

	const entryBodies = createDisposableCache((id: EntryId) => {
		const ydoc = new Y.Doc({ guid: entryContentDocGuid(id), gc: true });
		const { idb: bodyIdb } = wire(ydoc, {});
		const body = attachRichText(ydoc);
		const offLocalUpdate = onLocalUpdate(ydoc, () => {
			workspace.tables.entries.update(id, {
				updatedAt: DateTimeString.now(),
			});
		});
		return {
			ydoc,
			binding: body.binding,
			read: body.read,
			write: body.write,
			whenLoaded: bodyIdb.whenLoaded,
			[Symbol.dispose]() {
				offLocalUpdate();
				ydoc.destroy();
			},
		};
	});

	const markdown = createFujiMarkdownActions({
		tables: workspace.tables,
		idb,
		entryBodies,
	});

	return defineWorkspace({
		...workspace,
		actions: workspace.actions,
		markdown,
		idb,
		entryBodies,
		collaboration,
		async wipe() {
			entryBodies[Symbol.dispose]();
			workspace[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
		[Symbol.dispose]() {
			entryBodies[Symbol.dispose]();
			workspace[Symbol.dispose]();
		},
	});
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
