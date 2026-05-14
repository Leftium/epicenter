import { type LocalOwner } from '@epicenter/workspace';
import { zhongwenKv, zhongwenTables } from '@epicenter/zhongwen';
import * as Y from 'yjs';

export function openZhongwenBrowser({ owner }: { owner: LocalOwner }) {
	const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
	const encryption = owner.attachEncryption(ydoc);
	const tables = encryption.attachTables(zhongwenTables);
	const kv = encryption.attachKv(zhongwenKv);
	const idb = owner.attachIndexedDb(ydoc);
	owner.attachBroadcastChannel(ydoc);

	return {
		ydoc,
		tables,
		kv,
		encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		idb,
		async wipe() {
			ydoc.destroy();
			await idb.whenDisposed;
			await owner.wipeLocalYjsData([ydoc.guid]);
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type ZhongwenBrowser = ReturnType<typeof openZhongwenBrowser>;
