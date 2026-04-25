/**
 * Whispering workspace — module-scope inline composition.
 *
 * On desktop (Tauri), `attachRecordingMarkdownFiles` mirrors the `recordings`
 * table into `{id}.md` files on disk. It's a no-op in the browser.
 */

import {
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { PATHS } from '$lib/constants/paths';
import { attachRecordingMarkdownFiles } from './recording-materializer';
import { whisperingKv, whisperingTables } from './workspace';

// ─── ydoc + state ──────────────────────────────────────────────────────
const ydoc = new Y.Doc({ guid: 'whispering', gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, whisperingTables);
const kv = encryption.attachKv(ydoc, whisperingKv);

// ─── storage + materializers ───────────────────────────────────────────
const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

const recordingsFs = attachRecordingMarkdownFiles(ydoc, tables.recordings, {
	dir: PATHS.DB.RECORDINGS(),
	whenReady: idb.whenLoaded,
});

// ─── export ────────────────────────────────────────────────────────────
export const whispering = {
	ydoc,
	tables,
	kv,
	encryption,
	idb,
	batch: (fn: () => void) => ydoc.transact(fn),
	whenReady: Promise.all([idb.whenLoaded, recordingsFs.whenFlushed]),
	[Symbol.dispose]() {
		ydoc.destroy();
	},
};
