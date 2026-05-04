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
	const doc = openHoneycrispDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const noteBodyDocs = createDisposableCache(
		(noteId: NoteId) => {
			const ydoc = new Y.Doc({
				guid: noteBodyDocGuid({
					workspaceId: doc.ydoc.guid,
					noteId,
				}),
				gc: false,
			});
			const body = attachRichText(ydoc);
			const childIdb = attachIndexedDb(ydoc);
			const childSync = attachSync(ydoc, {
				url: toWsUrl(`${APP_URLS.API}/docs/${ydoc.guid}`),
				waitFor: childIdb.whenLoaded,
				openWebSocket: auth.openWebSocket,
				onCredentialChange: auth.onChange,
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
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime: 5_000 },
	);
	async function clearNoteBodyLocalData() {
		await Promise.all(
			doc.tables.notes.getAllValid().map((note) =>
				clearDocument(
					noteBodyDocGuid({
						workspaceId: doc.ydoc.guid,
						noteId: note.id,
					}),
				),
			),
		);
	}
	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		openWebSocket: auth.openWebSocket,
		onCredentialChange: auth.onChange,
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
		syncControl: sync,
		async clearLocalData() {
			await clearNoteBodyLocalData();
			await idb.clearLocal();
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
