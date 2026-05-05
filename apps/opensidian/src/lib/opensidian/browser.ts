import type { AuthClient, AuthIdentity } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachYjsFileSystem,
	createSqliteIndex,
	type FileId,
	fileContentDocGuid,
} from '@epicenter/filesystem';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachSync,
	attachTimeline,
	clearLocalYjsDataForUser,
	createDisposableCache,
	createLocalYjsKey,
	createRemoteClient,
	onLocalUpdate,
	PeerIdentity,
	SYNC_ORIGIN,
	toWsUrl,
} from '@epicenter/workspace';
import { Bash } from 'just-bash';
import * as Y from 'yjs';
import { createOpensidianActions } from './actions';
import { openOpensidian as openOpensidianDoc } from './index';

export function openOpensidian({
	auth,
	identity,
	peer,
}: {
	auth: AuthClient;
	identity: AuthIdentity;
	peer: PeerIdentity;
}) {
	const doc = openOpensidianDoc();
	doc.encryption.applyKeys(identity.encryptionKeys);

	const localKey = createLocalYjsKey(identity.user.id, doc.ydoc.guid);
	const idb = doc.encryption.attachEncryptedIndexedDb(doc.ydoc, {
		persistenceKey: localKey,
	});
	attachBroadcastChannel(doc.ydoc, {
		channelKey: localKey,
		transportOrigin: SYNC_ORIGIN,
	});

	const fileContentDocs = createDisposableCache((fileId: FileId) => {
		const ydoc = new Y.Doc({
			guid: fileContentDocGuid({
				workspaceId: doc.ydoc.guid,
				fileId,
			}),
			gc: false,
		});
		onLocalUpdate(ydoc, () =>
			doc.tables.files.update(fileId, { updatedAt: Date.now() }),
		);
		const childLocalKey = createLocalYjsKey(identity.user.id, ydoc.guid);
		const persistence = doc.encryption.attachEncryptedIndexedDb(ydoc, {
			persistenceKey: childLocalKey,
		});
		attachBroadcastChannel(ydoc, {
			channelKey: childLocalKey,
			transportOrigin: SYNC_ORIGIN,
		});
		return {
			ydoc,
			content: attachTimeline(ydoc),
			persistence,
			whenReady: persistence.whenLoaded,
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
	const fileContent = {
		async read(fileId: FileId) {
			await using handle = fileContentDocs.open(fileId);
			await handle.whenReady;
			return handle.content.read();
		},
		async write(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.whenReady;
			handle.content.write(text);
		},
		async append(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.whenReady;
			handle.content.appendText(text);
			return handle.content.read();
		},
	};
	const sqliteIndex = createSqliteIndex({
		readContent: fileContent.read,
	})({
		tables: doc.tables,
	}).exports;
	const fs = attachYjsFileSystem(doc.tables.files, fileContent);
	const bash = new Bash({ fs, cwd: '/' });
	const actions = createOpensidianActions({ fs, sqliteIndex, bash });

	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		auth,
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
		async wipe() {
			const fallbackGuids = [
				doc.ydoc.guid,
				...doc.tables.files.getAllValid().map((file) =>
					fileContentDocGuid({
						workspaceId: doc.ydoc.guid,
						fileId: file.id,
					}),
				),
			];
			fileContentDocs[Symbol.dispose]();
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
			fileContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
