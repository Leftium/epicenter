import type { AuthClient } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachRichText,
	attachSync,
	clearOwnedDocuments,
	createDisposableCache,
	createRemoteClient,
	DateTimeString,
	docGuid,
	onLocalUpdate,
	PeerIdentity,
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
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const identity = auth.identity;
	if (identity === null) {
		throw new Error(
			'openHoneycrisp requires signed-in auth.identity. Await auth.whenReady first.',
		);
	}
	const userId = identity.user.id;
	const doc = openHoneycrispDoc({ encryptionKeys: identity.encryptionKeys });

	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachBroadcastChannel(doc.ydoc, { userId });

	const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
		const ydoc = new Y.Doc({
			guid: noteBodyDocGuid({
				workspaceId: doc.ydoc.guid,
				noteId,
			}),
			gc: false,
		});
		const body = attachRichText(ydoc);
		const childIdb = doc.encryption.attachIndexedDb(ydoc, { userId });
		attachBroadcastChannel(ydoc, { userId });
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
			await clearOwnedDocuments({
				userId,
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
