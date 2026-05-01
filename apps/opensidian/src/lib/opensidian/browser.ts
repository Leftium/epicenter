import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachYjsFileSystem,
	createFileContentDoc,
	createSqliteIndex,
	type FileId,
} from '@epicenter/filesystem';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	createDisposableCache,
	type PeerIdentityInput,
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
	peer: PeerIdentityInput;
}) {
	const doc = openOpensidianDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const fileContentDocs = createDisposableCache(
		(fileId: FileId) =>
			createFileContentDoc({
				fileId,
				workspaceId: doc.ydoc.guid,
				filesTable: doc.tables.files,
				attachPersistence: (d) => attachIndexedDb(d),
			}),
		{ gcTime: 5_000 },
	);

	const sqliteIndex = createSqliteIndex(fileContentDocs)({
		tables: doc.tables,
	}).exports;
	const fs = attachYjsFileSystem(doc.tables.files, fileContentDocs);
	const bash = new Bash({ fs, cwd: '/' });
	const actions = createOpensidianActions({ fs, sqliteIndex, bash });

	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		getToken: async () => auth.getToken(),
	});
	const presence = sync.attachPresence({ peer });
	const rpc = sync.attachRpc(actions);

	return {
		...doc,
		idb,
		fileContentDocs,
		sqliteIndex,
		fs,
		bash,
		actions,
		sync,
		presence,
		rpc,
		/**
		 * Resolves when IndexedDB has hydrated the local snapshot: the UI can
		 * render with persisted data. Does NOT gate sync (the WebSocket can
		 * connect at any time, including never if the user is offline).
		 */
		whenReady: idb.whenLoaded,
	};
}
