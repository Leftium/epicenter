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
	attachEncryption,
	attachKv,
	attachTables,
} from '@epicenter/workspace';
import { isTauri } from '@tauri-apps/api/core';
import * as Y from 'yjs';
import { startRecordingMaterializer } from './recording-materializer';
import { whisperingKv, whisperingTables } from './workspace';

const whisperingFactory = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const tables = attachTables(ydoc, whisperingTables);
		const kv = attachKv(ydoc, whisperingKv);
		const enc = attachEncryption(ydoc, { tables, kv });

		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);

		return {
			id,
			ydoc,
			tables: tables.helpers,
			kv: kv.helper,
			enc,
			idb,
			batch: (fn: () => void) => ydoc.transact(fn),
			whenReady: idb.whenLoaded,
			whenDisposed: Promise.all([
				idb.whenDisposed,
				enc.whenDisposed,
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
