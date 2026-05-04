import { attachBroadcastChannel, attachIndexedDb } from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './index';

export function openZhongwen() {
	const doc = openZhongwenDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);
	return {
		...doc,
		idb,
		async wipe() {
			doc[Symbol.dispose]();
			await idb[Symbol.asyncDispose]();
			await idb.clearLocal();
		},
		whenLoaded: idb.whenLoaded,
	};
}
