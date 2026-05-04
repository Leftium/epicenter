import type { AuthClient } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachRichText,
	attachSync,
	createDisposableCache,
	createRemoteClient,
	DateTimeString,
	docGuid,
	onLocalUpdate,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import { clearDocument } from 'y-indexeddb';
import * as Y from 'yjs';
import type { EntryId } from '$lib/workspace';
import { openFuji as openFujiDoc } from './index';

function entryContentDocGuid({
	workspaceId,
	entryId,
}: {
	workspaceId: string;
	entryId: EntryId;
}): string {
	return docGuid({
		workspaceId,
		collection: 'entries',
		rowId: entryId,
		field: 'content',
	});
}

export function openFuji({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const doc = openFujiDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const entryContentDocs = createDisposableCache(
		(entryId: EntryId) => {
			const ydoc = new Y.Doc({
				guid: entryContentDocGuid({
					workspaceId: doc.ydoc.guid,
					entryId,
				}),
				gc: false,
			});
			const body = attachRichText(ydoc);
			const childIdb = attachIndexedDb(ydoc);
			const childSync = attachSync(ydoc, {
				url: toWsUrl(`${APP_URLS.API}/docs/${ydoc.guid}`),
				waitFor: childIdb.whenLoaded,
				auth,
			});

			onLocalUpdate(ydoc, () => {
				doc.tables.entries.update(entryId, {
					updatedAt: DateTimeString.now(),
				});
			});

			return {
				ydoc,
				body,
				idb: childIdb,
				sync: childSync,
				whenLoaded: childIdb.whenLoaded,
				/**
				 * child disposer rejections do not propagate; bundle.wipe() relies on
				 * IDB's deleteDatabase native blocking as belt-and-suspenders for
				 * storage deletion.
				 */
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime: 5_000 },
	);
	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		auth,
		awareness,
	});
	const rpc = sync.attachRpc(doc.actions);
	const remote = createRemoteClient({ awareness, rpc });

	return {
		...doc,
		idb,
		entryContentDocs,
		awareness,
		sync,
		async wipe() {
			entryContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
			await Promise.all([
				idb.whenDisposed,
				sync.whenDisposed,
			]);
			await Promise.all([
				...doc.tables.entries.getAllValid().map((entry) =>
					clearDocument(
						entryContentDocGuid({
							workspaceId: doc.ydoc.guid,
							entryId: entry.id,
						}),
					),
				),
				idb.clearLocal(),
			]);
		},
		remote,
		rpc,
		whenLoaded: idb.whenLoaded,
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
