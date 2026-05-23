/**
 * Opensidian browser composition.
 *
 * Single source of truth for "how Opensidian mounts in a browser." Calls
 * Tier 1 primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via attachEncryption)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. per-file child content docs (plaintext timeline + encrypted IDB storage)
 *  4. file system, sqlite index, bash, and action registry
 *  5. reconnect listener for the root and every live child sync
 *  6. wipe / dispose teardown
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this subject;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without touching
 * local storage.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachYjsFileSystem,
	createSqliteIndex,
	type FileId,
} from '@epicenter/filesystem';
import type { SignedIn } from '@epicenter/svelte';
import {
	attachEncryption,
	attachLocalStorage,
	attachTimeline,
	createDisposableCache,
	onLocalUpdate,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { Bash } from 'just-bash';
import {
	opensidianFileContentDocGuid,
	OPENSIDIAN_ID,
	opensidianTables,
} from 'opensidian';
import * as Y from 'yjs';
import { createOpensidianActions } from './actions';

export function openOpensidianBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ydoc = new Y.Doc({ guid: OPENSIDIAN_ID, gc: true });
	const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
	const tables = encryption.attachTables(opensidianTables);
	const kv = encryption.attachKv({});

	const idb = attachLocalStorage(ydoc, signedIn);

	const fileContentDocs = createDisposableCache((fileId: FileId) => {
		const childYdoc = new Y.Doc({
			guid: opensidianFileContentDocGuid(fileId),
			gc: true,
		});
		onLocalUpdate(childYdoc, () =>
			tables.files.update(fileId, { updatedAt: Date.now() }),
		);
		const childIdb = attachLocalStorage(childYdoc, signedIn);
		// File bodies sync through Cloud so device loss doesn't drop the largest
		// data class.
		const childSync = openCollaboration(childYdoc, {
			url: roomWsUrl(APP_URLS.API, childYdoc.guid),
			openWebSocket: signedIn.auth.openWebSocket,
			waitFor: childIdb.whenLoaded,
			installationId,
			actions: {},
		});
		return {
			ydoc: childYdoc,
			content: attachTimeline(childYdoc),
			idb: childIdb,
			sync: childSync,
			/**
			 * Child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				childYdoc.destroy();
			},
		};
	});
	const fileContent = {
		async read(fileId: FileId) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			return handle.content.read();
		},
		async write(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			handle.content.write(text);
		},
		async append(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			handle.content.appendText(text);
			return handle.content.read();
		},
	};
	const sqliteIndex = createSqliteIndex({
		readContent: fileContent.read,
	})({
		tables,
	});
	const sqliteIndexExports = sqliteIndex.exports;
	const fs = attachYjsFileSystem(ydoc, tables.files, fileContent);
	const bash = new Bash({ fs, cwd: '/' });
	const actions = createOpensidianActions({
		fs,
		sqliteIndex: sqliteIndexExports,
		bash,
	});

	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl(APP_URLS.API, ydoc.guid),
		openWebSocket: signedIn.auth.openWebSocket,
		waitFor: idb.whenLoaded,
		installationId,
		actions,
	});

	// Auth transitions: tell live sockets to retry.
	// Sign-in: a previously-rejected socket reconnects with the new token.
	// Sign-out: the server closes the existing socket on its own (4401);
	//   reconnect() ensures the supervisor doesn't sit in 'failed' if the
	//   user signs back in.
	const unsubscribeAuth = signedIn.auth.onStateChange(() => {
		collaboration.reconnect();
		for (const child of fileContentDocs.values()) {
			child.sync.reconnect();
		}
	});

	let docsTornDown = false;

	function teardownDocs() {
		if (docsTornDown) return;
		docsTornDown = true;
		fileContentDocs[Symbol.dispose]();
		sqliteIndex[Symbol.dispose]();
		ydoc.destroy();
	}

	return {
		ydoc,
		tables,
		kv,
		idb,
		fileContentDocs,
		sqliteIndex: sqliteIndexExports,
		fs,
		bash,
		actions,
		collaboration,
		async wipe() {
			teardownDocs();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({ subject: signedIn.subject });
		},
		[Symbol.dispose]() {
			unsubscribeAuth();
			teardownDocs();
		},
	};
}

export type OpensidianBrowser = ReturnType<typeof openOpensidianBrowser>;
