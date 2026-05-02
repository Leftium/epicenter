import { attachBroadcastChannel, attachIndexedDb } from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './index';

export function openZhongwen() {
	const doc = openZhongwenDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);
	return {
		...doc,
		idb,
		async clearLocalData() {
			await idb.clearLocal();
		},
		whenLoaded: idb.whenLoaded,
	};
}
