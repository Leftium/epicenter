/** `recordingsFs` is a no-op in non-Tauri environments. */

import { attachBroadcastChannel, attachIndexedDb } from '@epicenter/workspace';
import { attachRecordingMarkdownFiles } from '$lib/recording-materializer';
import { createWhisperingWorkspace } from './index';

export function openWhispering() {
	const workspace = createWhisperingWorkspace();

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	const recordingsFs = attachRecordingMarkdownFiles(
		workspace.ydoc,
		workspace.tables.recordings,
		{
			waitFor: idb.whenLoaded,
		},
	);

	return {
		...workspace,
		idb,
		recordingsFs,
		whenReady: Promise.all([idb.whenLoaded, recordingsFs.whenFlushed]),
	};
}
