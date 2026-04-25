/**
 * Whispering workspace client.
 *
 * On desktop (Tauri), `recordingsFs` mirrors the `recordings` table into
 * `{id}.md` files on disk. It's a no-op in the browser.
 *
 * Module-scope flat exports — the file IS the workspace recipe, top-down.
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
export const ydoc = new Y.Doc({ guid: 'whispering', gc: false });
export const encryption = attachEncryption(ydoc);
export const tables = encryption.attachTables(ydoc, whisperingTables);
export const kv = encryption.attachKv(ydoc, whisperingKv);

// ─── storage + materializers ───────────────────────────────────────────
export const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

export const recordingsFs = attachRecordingMarkdownFiles(ydoc, tables.recordings, {
	dir: PATHS.DB.RECORDINGS(),
	whenReady: idb.whenLoaded,
});

export const batch = (fn: () => void) => ydoc.transact(fn);
export const whenReady = Promise.all([idb.whenLoaded, recordingsFs.whenFlushed]);
