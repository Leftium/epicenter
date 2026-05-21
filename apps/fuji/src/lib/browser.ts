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
 * Cloud sync is routed through one `cloudWorkspaceSync.forApp(...)` factory
 * per app instance: the root doc and every entry-body child doc share that
 * factory's workspace lookup and auth-state subscription.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root + cached child Y.Docs and the cloud
 * sync factory without touching local storage.
 */

import type { AuthClient } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachRichText,
	cloudWorkspaceSync,
	createDisposableCache,
	DateTimeString,
	type LocalOwner,
	onLocalUpdate,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { type EntryId, openFujiWorkspace } from './workspace';

export function openFujiBrowser({
	owner,
	installationId,
	auth,
}: {
	owner: LocalOwner;
	installationId: string;
	auth: AuthClient;
}) {
	const workspace = openFujiWorkspace(owner.attachEncryption);
	const { ydoc: rootYdoc, tables, kv } = workspace;

	const idb = owner.attachLocal(rootYdoc);

	const fujiCloud = cloudWorkspaceSync.forApp({
		auth,
		apiUrl: APP_URLS.API,
		appId: 'fuji',
	});

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const ydoc = new Y.Doc({
			guid: workspace.entryContentDocGuid(entryId),
			gc: true,
		});
		const body = attachRichText(ydoc);
		const childIdb = owner.attachLocal(ydoc);
		// docId defaults to ydoc.guid (`${workspaceId}.entries.${entryId}.content`),
		// which is the same string used as the local guid and matches
		// ROUTE_ID_PATTERN. One canonical id for both local and cloud.
		const childSync = fujiCloud.open(ydoc, {
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
			 * child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});

	const collaboration = fujiCloud.open(rootYdoc, {
		// Explicit "root" preserves the cloud-side identity of the canonical
		// app entry document; rootYdoc.guid is the workspace id, not "root".
		docId: 'root',
		waitFor: idb.whenLoaded,
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
			fujiCloud[Symbol.dispose]();
		},
	};
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
