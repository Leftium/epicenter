import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachYjsFileSystem,
	createFileContentDoc,
	createSqliteIndex,
	type FileId,
} from '@epicenter/filesystem';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	createBrowserDocumentCollection,
	createRemoteClient,
	docGuid,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import { Bash } from 'just-bash';
import { createOpensidianActions } from './actions';
import { openOpensidian as openOpensidianDoc } from './index';

export function openOpensidian({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const doc = openOpensidianDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const fileContentDocs = createBrowserDocumentCollection({
		ids: () => doc.tables.files.getAllValid().map((file) => file.id),
		guid: (fileId: FileId) =>
			docGuid({
				workspaceId: doc.ydoc.guid,
				collection: 'files',
				rowId: fileId,
				field: 'content',
			}),
		build: (fileId: FileId) =>
			createFileContentDoc({
				fileId,
				workspaceId: doc.ydoc.guid,
				filesTable: doc.tables.files,
				attachPersistence: (d) => attachIndexedDb(d),
			}),
		gcTime: 5_000,
	});
	const sqliteIndex = createSqliteIndex(fileContentDocs)({
		tables: doc.tables,
	}).exports;
	const fs = attachYjsFileSystem(doc.tables.files, fileContentDocs);
	const bash = new Bash({ fs, cwd: '/' });
	const actions = createOpensidianActions({ fs, sqliteIndex, bash });

	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		getToken: async () => {
			await auth.whenLoaded;

			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
		awareness,
	});
	const rpc = sync.attachRpc(actions);
	const remote = createRemoteClient({ awareness, rpc });

	return {
		...doc,
		idb,
		fileContentDocs,
		sqliteIndex,
		fs,
		bash,
		actions,
		awareness,
		sync,
		remote,
		rpc,
		whenLoaded: idb.whenLoaded,
		[Symbol.dispose]() {
			fileContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
