import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { zhongwenKv, zhongwenTables } from '$lib/workspace';

export function openZhongwen() {
	const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, zhongwenTables);
	const kv = encryption.attachKv(ydoc, zhongwenKv);
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
