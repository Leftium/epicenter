import {
	attachAwareness,
	attachEncryption,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createTabManagerActions } from '$lib/workspace/actions';
import {
	tabManagerAwarenessDefs,
	tabManagerTables,
} from '$lib/workspace/definition';

export function openTabManager() {
	const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, tabManagerTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, tabManagerAwarenessDefs);
	const batch = (fn: () => void) => ydoc.transact(fn);
	const actions = createTabManagerActions({ tables, batch });
	return {
		ydoc,
		tables,
		kv,
		encryption,
		awareness,
		actions,
		batch,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
