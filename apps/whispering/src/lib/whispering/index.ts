import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { whisperingKv, whisperingTables } from '$lib/workspace';

export function openWhispering() {
	const ydoc = new Y.Doc({ guid: 'whispering', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(whisperingTables);
	const kv = encryption.attachKv(whisperingKv);
	return {
		ydoc,
		tables,
		kv,
		encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
