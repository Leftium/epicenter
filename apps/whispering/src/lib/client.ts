/**
 * Whispering workspace client — a single `defineDocument` closure that owns
 * the Y.Doc construction and composes every attachment inline.
 *
 * On desktop (Tauri), the recording materializer mirrors the `recordings`
 * table into `{id}.md` files on disk. The materializer is an orthogonal
 * side-effect on top of the workspace — it starts AFTER `factory.open()`
 * returns, outside the closure, so the closure stays pure workspace
 * construction. See `./recording-materializer.ts`.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineDocument,
} from '@epicenter/document';
import {
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
} from '@epicenter/workspace';
import { isTauri } from '@tauri-apps/api/core';
import * as Y from 'yjs';
import { startRecordingMaterializer } from './recording-materializer';
import { whisperingKv, whisperingTables } from './workspace';

const whisperingFactory = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const encryption = attachEncryption(ydoc);
		const tables = attachEncryptedTables(ydoc, encryption, whisperingTables);
		const kv = attachEncryptedKv(ydoc, encryption, whisperingKv);

		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);

		return {
			id,
			ydoc,
			tables,
			kv,
			encryption,
			idb,
			batch: (fn: () => void) => ydoc.transact(fn),
			whenReady: idb.whenLoaded,
			whenDisposed: Promise.all([
				idb.whenDisposed,
				encryption.whenDisposed,
			]).then(() => {}),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: Number.POSITIVE_INFINITY },
);

export const workspace = whisperingFactory.open('whispering');

if (isTauri()) {
	void startRecordingMaterializer({
		recordings: workspace.tables.recordings,
		whenReady: workspace.whenReady,
	});
}
