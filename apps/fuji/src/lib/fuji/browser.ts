import type { AuthIdentity } from '@epicenter/auth';
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
	identity,
	peer,
	bearerToken,
}: {
	identity: AuthIdentity;
	peer: PeerIdentity;
	bearerToken?: () => string | null;
}) {
	const userId = identity.user.id;
	const doc = openFujiDoc({ encryptionKeys: identity.encryptionKeys });

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
		bearerToken,
		awareness,
	});
	const rpc = sync.attachRpc(doc.actions);
	const remote = createRemoteClient({ awareness, rpc });
	const dispose = () => {
		entryContentDocs[Symbol.dispose]();
		doc[Symbol.dispose]();
	};

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
		whenLoaded: idb.whenLoaded,
		whenReady: idb.whenLoaded,
		dispose,
		[Symbol.dispose]: dispose,
	};
}

export type Fuji = ReturnType<typeof openFuji>;
