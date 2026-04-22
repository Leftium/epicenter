/**
 * Whispering workspace client — a direct `openWhispering()` call that
 * owns the Y.Doc construction and composes every attachment inline.
 *
 * On desktop (Tauri), `attachRecordingMarkdownFiles` mirrors the `recordings`
 * table into `{id}.md` files on disk. It's a no-op in the browser.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
} from '@epicenter/workspace';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { PATHS } from '$lib/constants/paths';
import { attachRecordingMarkdownFiles } from './recording-materializer';
import { whisperingKv, whisperingTables } from './workspace';

export function openWhispering() {
	const id = 'whispering';
	const ydoc = new Y.Doc({ guid: id, gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, whisperingTables);
	const kv = encryption.attachKv(ydoc, whisperingKv);

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
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const workspace = openWhispering();
