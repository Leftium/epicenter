import { APP_URLS } from '@epicenter/constants/vite';
import {
	createHoneycrispActions,
	honeycrispTables,
	type NoteId,
} from '@epicenter/honeycrisp';
import {
	attachEncryption,
	attachOwnedBroadcastChannel,
	attachRichText,
	createDisposableCache,
	DateTimeString,
	docGuid,
	type EncryptionKeys,
	type OpenWebSocket,
	onLocalUpdate,
	openCollaboration,
	websocketUrl,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import * as Y from 'yjs';

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

export function openHoneycrispBrowser({
	userId,
	replicaId,
	openWebSocket,
	encryptionKeys,
}: {
	userId: string;
	replicaId: string;
	openWebSocket?: OpenWebSocket;
	encryptionKeys: () => EncryptionKeys;
}) {
	const rootYdoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
	const encryption = attachEncryption(rootYdoc, { encryptionKeys });
	const tables = encryption.attachTables(honeycrispTables);
	const kv = encryption.attachKv({});

	const idb = encryption.attachIndexedDb(rootYdoc, { userId });
	attachOwnedBroadcastChannel(rootYdoc, { userId });

	const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
		const ydoc = new Y.Doc({
			guid: noteBodyDocGuid({
				workspaceId: rootYdoc.guid,
				noteId,
			}),
			gc: false,
		});
		const body = attachRichText(ydoc);
		const childIdb = encryption.attachIndexedDb(ydoc, { userId });
		attachOwnedBroadcastChannel(ydoc, { userId });
		const childSync = openCollaboration(ydoc, {
			url: websocketUrl(`${APP_URLS.API}/documents/${ydoc.guid}`),
			waitFor: childIdb.whenLoaded,
			openWebSocket,
			replicaId,
		});

		onLocalUpdate(ydoc, () => {
			tables.notes.update(noteId, {
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

	const actions = createHoneycrispActions(tables);
	const collaboration = openCollaboration(rootYdoc, {
		url: websocketUrl(`${APP_URLS.API}/workspaces/${rootYdoc.guid}`),
		waitFor: idb.whenLoaded,
		openWebSocket,
		replicaId,
		actions,
	});

	return {
		ydoc: rootYdoc,
		tables,
		kv,
		batch: (fn: () => void) => rootYdoc.transact(fn),
		idb,
		noteBodyDocs,
		collaboration,
		async wipe() {
			const fallbackGuids = [
				rootYdoc.guid,
				...tables.notes.getAllValid().map((note) =>
					noteBodyDocGuid({
						workspaceId: rootYdoc.guid,
						noteId: note.id,
					}),
				),
			];
			noteBodyDocs[Symbol.dispose]();
			rootYdoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: fallbackGuids,
			});
		},
		[Symbol.dispose]() {
			noteBodyDocs[Symbol.dispose]();
			rootYdoc.destroy();
		},
	};
}

export type HoneycrispBrowser = ReturnType<typeof openHoneycrispBrowser>;
