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
import type { NoteId } from '$lib/workspace';
import { openHoneycrisp as openHoneycrispDoc } from './index';

function noteBodyDocGuid({
	workspaceId,
	noteId,
}: {
	workspaceId: string;
	noteId: NoteId;
}): string {
	return docGuid({
		workspaceId,
		collection: 'notes',
		rowId: noteId,
		field: 'body',
	});
}

export function openHoneycrisp({
	auth,
	identity,
	peer,
}: {
	auth: AuthClient;
	identity: AuthIdentity;
	peer: PeerIdentity;
}) {
	const doc = openHoneycrispDoc();
	doc.encryption.applyKeys(identity.encryptionKeys);

	const localKey = createLocalYjsKey(identity.user.id, doc.ydoc.guid);
	const idb = doc.encryption.attachEncryptedIndexedDb(doc.ydoc, {
		persistenceKey: localKey,
	});
	attachBroadcastChannel(doc.ydoc, {
		channelKey: localKey,
		transportOrigin: SYNC_ORIGIN,
	});

	const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
		const ydoc = new Y.Doc({
			guid: noteBodyDocGuid({
				workspaceId: doc.ydoc.guid,
				noteId,
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
			doc.tables.notes.update(noteId, {
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
		noteBodyDocs,
		awareness,
		sync,
		async wipe() {
			const fallbackGuids = [
				doc.ydoc.guid,
				...doc.tables.notes.getAllValid().map((note) =>
					noteBodyDocGuid({
						workspaceId: doc.ydoc.guid,
						noteId: note.id,
					}),
				),
			];
			noteBodyDocs[Symbol.dispose]();
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
			noteBodyDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
