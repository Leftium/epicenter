import {
	attachAwareness,
	attachEncryption,
	standardAwarenessDefs,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createHoneycrispActions, honeycrispTables } from '$lib/workspace';

export function openHoneycrisp() {
	const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, honeycrispTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, { ...standardAwarenessDefs });
	const actions = createHoneycrispActions(tables);
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
