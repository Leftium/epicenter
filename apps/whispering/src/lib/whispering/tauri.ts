/** `recordingsFs` is a no-op in non-Tauri environments. */

import { attachBroadcastChannel, attachIndexedDb } from '@epicenter/workspace';
import { attachRecordingMarkdownExport } from '$lib/recording-markdown-export';
import { createWhisperingWorkspace } from './index';

export function openWhispering() {
	const workspace = createWhisperingWorkspace();

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	const recordingsFs = attachRecordingMarkdownExport(
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
		whenReady: idb.whenLoaded,
	};
}
