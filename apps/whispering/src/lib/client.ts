/**
 * Whispering workspace client.
 *
 * On desktop (Tauri), `recordingsFs` mirrors the `recordings` table into
 * `{id}.md` files on disk. It's a no-op in the browser. The mirror is a
 * sibling of the bare workspace bundle since it operates on the workspace's
 * tables but isn't itself part of the workspace primitive.
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

function openWhispering() {
	const ydoc = new Y.Doc({ guid: 'whispering', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, whisperingTables);
	const kv = encryption.attachKv(ydoc, whisperingKv);

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	return {
		ydoc,
		tables,
		kv,
		encryption,
		idb,
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const whispering = openWhispering();

export const recordingsFs = attachRecordingMarkdownFiles(
	whispering.ydoc,
	whispering.tables.recordings,
	{
		dir: PATHS.DB.RECORDINGS(),
		whenReady: whispering.idb.whenLoaded,
	},
);
