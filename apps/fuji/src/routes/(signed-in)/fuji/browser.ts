import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachEncryption,
	attachOwnedBroadcastChannel,
	attachRichText,
	createDisposableCache,
	DateTimeString,
	docGuid,
	type EncryptionKeys,
	onLocalUpdate,
	type OpenWebSocket,
	openCollaboration,
	websocketUrl,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import {
	createFujiActions,
	type EntryId,
	FUJI_WORKSPACE_ID,
	fujiTables,
} from '@epicenter/fuji';

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

export function openFujiBrowser({
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
	const rootYdoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
	const encryption = attachEncryption(rootYdoc, { encryptionKeys });
	const tables = encryption.attachTables(fujiTables);
	const kv = encryption.attachKv({});

	const idb = encryption.attachIndexedDb(rootYdoc, { userId });
	attachOwnedBroadcastChannel(rootYdoc, { userId });

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const ydoc = new Y.Doc({
			guid: entryContentDocGuid({
				workspaceId: rootYdoc.guid,
				entryId,
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

	const actions = createFujiActions(tables);
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
		entryContentDocs,
		collaboration,
		async wipe() {
			const fallbackGuids = [
				rootYdoc.guid,
				...tables.entries.getAllValid().map((entry) =>
					entryContentDocGuid({
						workspaceId: rootYdoc.guid,
						entryId: entry.id,
					}),
				),
			];
			entryContentDocs[Symbol.dispose]();
			rootYdoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: fallbackGuids,
			});
		},
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			rootYdoc.destroy();
		},
	};
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
