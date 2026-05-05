import type { AuthClient, AuthIdentity } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachRichText,
	attachSync,
	clearLocalYjsDataForUser,
	createDisposableCache,
	createLocalYjsKey,
	createRemoteClient,
	DateTimeString,
	docGuid,
	onLocalUpdate,
	PeerIdentity,
	SYNC_ORIGIN,
	toWsUrl,
} from '@epicenter/workspace';
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
	identity,
	peer,
}: {
	auth: AuthClient;
	identity: AuthIdentity;
	peer: PeerIdentity;
}) {
	const doc = openFujiDoc();
	doc.encryption.applyKeys(identity.encryptionKeys);

	const localKey = createLocalYjsKey(identity.user.id, doc.ydoc.guid);
	const idb = doc.encryption.attachEncryptedIndexedDb(doc.ydoc, {
		persistenceKey: localKey,
	});
	attachBroadcastChannel(doc.ydoc, {
		channelKey: localKey,
		transportOrigin: SYNC_ORIGIN,
	});

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const ydoc = new Y.Doc({
			guid: entryContentDocGuid({
				workspaceId: doc.ydoc.guid,
				entryId,
			}),
			gc: false,
		});
		const body = attachRichText(ydoc);
		const childLocalKey = createLocalYjsKey(identity.user.id, ydoc.guid);
		const childIdb = doc.encryption.attachEncryptedIndexedDb(ydoc, {
			persistenceKey: childLocalKey,
		});
		attachBroadcastChannel(ydoc, {
			channelKey: childLocalKey,
			transportOrigin: SYNC_ORIGIN,
		});
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
	});
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
			await clearLocalYjsDataForUser({
				userId: identity.user.id,
				ydocGuids: fallbackGuids,
			});
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
