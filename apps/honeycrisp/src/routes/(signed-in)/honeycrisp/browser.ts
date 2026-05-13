import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachOwnedBroadcastChannel,
	attachRichText,
	attachYjsSync,
	createDisposableCache,
	DateTimeString,
	docGuid,
	type EncryptionKeys,
	onLocalUpdate,
	type OpenWebSocket,
	openWorkspace,
	type PeerIdentity,
	toWsUrl,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { openHoneycrisp as openHoneycrispDoc } from './index';
import type { NoteId } from './workspace';

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
	userId,
	peer,
	openWebSocket,
	encryptionKeys,
}: {
	userId: string;
	peer: PeerIdentity;
	openWebSocket?: OpenWebSocket;
	encryptionKeys: () => EncryptionKeys;
}) {
	const doc = openHoneycrispDoc({ encryptionKeys });

	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

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
		attachOwnedBroadcastChannel(ydoc, { userId });
		const childSync = attachYjsSync(ydoc, {
			url: toWsUrl(`${APP_URLS.API}/documents/${ydoc.guid}`),
			waitFor: childIdb.whenLoaded,
			openWebSocket,
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

	const workspace = openWorkspace(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb.whenLoaded,
		openWebSocket,
		identity: peer,
		actions: doc.actions,
	});

	return {
		...doc,
		idb,
		noteBodyDocs,
		workspace,
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
			await Promise.all([idb.whenDisposed, workspace.whenDisposed]);
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: fallbackGuids,
			});
		},
		[Symbol.dispose]() {
			noteBodyDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}

export type Honeycrisp = ReturnType<typeof openHoneycrisp>;
