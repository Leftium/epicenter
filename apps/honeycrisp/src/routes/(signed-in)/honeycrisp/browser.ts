import { APP_URLS } from '@epicenter/constants/vite';
import {
	createHoneycrispActions,
	honeycrispTables,
	type NoteId,
} from '@epicenter/honeycrisp';
import {
	attachRichText,
	createDisposableCache,
	DateTimeString,
	docGuid,
	type LocalOwner,
	type OpenWebSocket,
	onLocalUpdate,
	openCollaboration,
	websocketUrl,
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
	owner,
	replicaId,
	openWebSocket,
}: {
	owner: LocalOwner;
	replicaId: string;
	openWebSocket?: OpenWebSocket;
}) {
	const rootYdoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
	const encryption = owner.attachEncryption(rootYdoc);
	const tables = encryption.attachTables(honeycrispTables);
	const kv = encryption.attachKv({});

	const idb = owner.attachIndexedDb(rootYdoc);
	owner.attachBroadcastChannel(rootYdoc);

	const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
		const ydoc = new Y.Doc({
			guid: noteBodyDocGuid({
				workspaceId: rootYdoc.guid,
				noteId,
			}),
			gc: false,
		});
		const body = attachRichText(ydoc);
		const childIdb = owner.attachIndexedDb(ydoc);
		owner.attachBroadcastChannel(ydoc);
		const childSync = openCollaboration(ydoc, {
			url: websocketUrl(`${APP_URLS.API}/documents/${ydoc.guid}`),
			waitFor: childIdb.whenLoaded,
			openWebSocket,
			replicaId,
			actions: {},
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
			await owner.wipeLocalYjsData(fallbackGuids);
		},
		[Symbol.dispose]() {
			noteBodyDocs[Symbol.dispose]();
			rootYdoc.destroy();
		},
	};
}

export type HoneycrispBrowser = ReturnType<typeof openHoneycrispBrowser>;
