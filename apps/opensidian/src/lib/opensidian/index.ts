import {
	attachAwareness,
	attachEncryption,
	standardAwarenessDefs,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { opensidianTables } from '$lib/workspace/definition';

export function openOpensidian() {
	const ydoc = new Y.Doc({ guid: 'epicenter.opensidian', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, opensidianTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, { ...standardAwarenessDefs });
	return {
		ydoc,
		tables,
		kv,
		encryption,
		awareness,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
