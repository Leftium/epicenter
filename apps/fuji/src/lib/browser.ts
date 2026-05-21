/**
 * Fuji browser runtime composition.
 *
 * Wraps `openFujiWorkspace(owner.attachEncryption)` with browser-only
 * attachments (encrypted IndexedDB, BroadcastChannel, root collaboration) and
 * a disposable cache of per-entry rich-text body sub-docs that each open their
 * own IDB/BroadcastChannel/sync. The action set comes from the shared
 * workspace opener so daemon-side and browser-side action surfaces stay
 * identical without a second factory call here.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without
 * touching local storage.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachRichText,
	createDisposableCache,
	DateTimeString,
	type DefaultCloudWorkspaceAuth,
	type LocalOwner,
	type OpenWebSocket,
	onLocalUpdate,
	openDefaultWorkspaceAppDocCollaboration,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import {
	FUJI_CLOUD_APP_ID,
	FUJI_ROOT_DOC_ID,
	fujiEntryContentDocId,
} from './sync-docs';
import { type EntryId, openFujiWorkspace } from './workspace';

export function openFujiBrowser({
	owner,
	installationId,
	auth,
	openWebSocket,
}: {
	owner: LocalOwner;
	installationId: string;
	auth: DefaultCloudWorkspaceAuth;
	openWebSocket?: OpenWebSocket;
}) {
	const workspace = openFujiWorkspace(owner.attachEncryption);
	const { ydoc: rootYdoc, tables, kv } = workspace;

	const idb = owner.attachLocal(rootYdoc);

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const ydoc = new Y.Doc({
			guid: workspace.entryContentDocGuid(entryId),
			gc: true,
		});
		const body = attachRichText(ydoc);
		const childIdb = owner.attachLocal(ydoc);
		const childSync = openDefaultWorkspaceAppDocCollaboration(ydoc, {
			auth,
			apiUrl: APP_URLS.API,
			appId: FUJI_CLOUD_APP_ID,
			docId: fujiEntryContentDocId(entryId),
			waitFor: childIdb.whenLoaded,
			openWebSocket,
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
			 * child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});

	const collaboration = openDefaultWorkspaceAppDocCollaboration(rootYdoc, {
		auth,
		apiUrl: APP_URLS.API,
		appId: FUJI_CLOUD_APP_ID,
		docId: FUJI_ROOT_DOC_ID,
		waitFor: idb.whenLoaded,
		openWebSocket,
		installationId,
		actions: workspace.actions,
	});

	return {
		ydoc: rootYdoc,
		tables,
		kv,
		batch: workspace.batch,
		idb,
		entryContentDocs,
		collaboration,
		async wipe() {
			const fallbackGuids = [
				rootYdoc.guid,
				...tables.entries
					.getAllValid()
					.map((entry) => workspace.entryContentDocGuid(entry.id)),
			];
			entryContentDocs[Symbol.dispose]();
			rootYdoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await owner.wipeLocalYjsData(fallbackGuids);
		},
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			rootYdoc.destroy();
		},
	};
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
