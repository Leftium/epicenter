import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachOwnedBroadcastChannel,
	attachRichText,
	attachSync,
	createDisposableCache,
	createRemoteClient,
	DateTimeString,
	docGuid,
	type EncryptionKeys,
	onLocalUpdate,
	PeerIdentity,
	toWsUrl,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { openFuji as openFujiDoc } from './index';
import type { EntryId } from './workspace';

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
	userId,
	peer,
	bearerToken,
	encryptionKeys,
}: {
	userId: string;
	peer: PeerIdentity;
	bearerToken?: () => string | null;
	encryptionKeys: () => EncryptionKeys;
}) {
	const doc = openFujiDoc({ encryptionKeys });

	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const ydoc = new Y.Doc({
			guid: entryContentDocGuid({
				workspaceId: doc.ydoc.guid,
				entryId,
			}),
			gc: false,
		});
		const body = attachRichText(ydoc);
		const childIdb = doc.encryption.attachIndexedDb(ydoc, { userId });
		attachOwnedBroadcastChannel(ydoc, { userId });
		const childSync = attachSync(ydoc, {
			url: toWsUrl(`${APP_URLS.API}/docs/${ydoc.guid}`),
			waitFor: childIdb.whenLoaded,
			bearerToken,
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
	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb.whenLoaded,
		bearerToken,
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
			const fallbackGuids = [
				doc.ydoc.guid,
				...doc.tables.entries.getAllValid().map((entry) =>
					entryContentDocGuid({
						workspaceId: doc.ydoc.guid,
						entryId: entry.id,
					}),
				),
			];
			entryContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, sync.whenDisposed]);
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: fallbackGuids,
			});
		},
		remote,
		rpc,
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}

export type Fuji = ReturnType<typeof openFuji>;
