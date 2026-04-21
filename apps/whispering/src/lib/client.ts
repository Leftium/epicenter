/**
 * Whispering workspace client — a single `defineDocument` closure that owns
 * the Y.Doc construction and composes every attachment inline.
 *
 * On desktop (Tauri), `attachRecordingMarkdownFiles` mirrors the `recordings`
 * table into `{id}.md` files on disk. It's a no-op in the browser.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineDocument,
} from '@epicenter/workspace';
import {
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { PATHS } from '$lib/constants/paths';
import { attachRecordingMarkdownFiles } from './recording-materializer';
import { whisperingKv, whisperingTables } from './workspace';

const whisperingFactory = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const encryption = attachEncryption(ydoc);
		const tables = attachEncryptedTables(ydoc, encryption, whisperingTables);
		const kv = attachEncryptedKv(ydoc, encryption, whisperingKv);

		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);

		const recordingsFs = attachRecordingMarkdownFiles(ydoc, tables.recordings, {
			dir: PATHS.DB.RECORDINGS(),
			whenReady: idb.whenLoaded,
		});

		return {
			id,
			ydoc,
			tables,
			kv,
			encryption,
			idb,
			batch: (fn: () => void) => ydoc.transact(fn),
			whenReady: Promise.all([idb.whenLoaded, recordingsFs.whenFlushed]).then(
				() => {},
			),
			whenDisposed: Promise.all([
				idb.whenDisposed,
				encryption.whenDisposed,
				recordingsFs.whenDisposed,
			]).then(() => {}),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: Number.POSITIVE_INFINITY },
);

export const workspace = whisperingFactory.open('whispering');
