/**
 * Whispering workspace client — single Y.Doc with IndexedDB persistence and
 * cross-tab BroadcastChannel sync.
 *
 * On desktop (Tauri), the recording materializer mirrors the `recordings`
 * table into `{id}.md` files on disk. See `./recording-materializer.ts`.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
} from '@epicenter/document';
import { isTauri } from '@tauri-apps/api/core';
import { startRecordingMaterializer } from './recording-materializer';
import { whispering } from './workspace';

const base = whispering.open('whispering');
const idb = attachIndexedDb(base.ydoc);
attachBroadcastChannel(base.ydoc);

export const workspace = Object.assign(base, {
	idb,
	whenReady: idb.whenLoaded,
});

if (isTauri()) {
	void startRecordingMaterializer({
		recordings: workspace.tables.recordings,
		whenReady: workspace.whenReady,
	});
}
