import {
	attachAwareness,
	attachEncryption,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createFujiActions, fujiTables } from '$lib/workspace';

export function openFuji() {
	const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, fujiTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, {});
	const actions = createFujiActions(tables);
	return {
		ydoc,
		tables,
		kv,
		encryption,
		awareness,
		actions,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
