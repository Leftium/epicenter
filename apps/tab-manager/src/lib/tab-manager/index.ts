import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createTabManagerActions } from '$lib/workspace/actions';
import { type DeviceId, tabManagerTables } from '$lib/workspace/definition';

export function openTabManager({ deviceId }: { deviceId: Promise<DeviceId> }) {
	const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, tabManagerTables);
	const kv = encryption.attachKv(ydoc, {});
	const batch = (fn: () => void) => ydoc.transact(fn);
	const actions = createTabManagerActions({ tables, batch, deviceId });
	return {
		ydoc,
		tables,
		kv,
		encryption,
		actions,
		batch,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
