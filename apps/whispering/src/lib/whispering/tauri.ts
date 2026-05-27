/** `recordingsFs` is a no-op in non-Tauri environments. */

import { attachBroadcastChannel, attachIndexedDb } from '@epicenter/workspace';
import { attachRecordingMarkdownFiles } from '$lib/recording-materializer';
import { deviceConfig } from '$lib/state/device-config.svelte';
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

	let recordingsExport:
		| ReturnType<typeof attachRecordingMarkdownFiles>
		| undefined;

	function attachRecordingsExport(dir: string | null) {
		recordingsExport?.[Symbol.dispose]();
		recordingsExport = dir
			? attachRecordingMarkdownFiles(
					workspace.ydoc,
					workspace.tables.recordings,
					{
						dir,
						waitFor: idb.whenLoaded,
					},
				)
			: undefined;
	}

	attachRecordingsExport(deviceConfig.get('recording.markdownExportDir'));

	const unobserveMarkdownExportDir = deviceConfig.observe(
		'recording.markdownExportDir',
		attachRecordingsExport,
	);

	workspace.ydoc.once('destroy', () => {
		unobserveMarkdownExportDir();
		recordingsExport?.[Symbol.dispose]();
	});

	return {
		...workspace,
		idb,
		recordingsFs,
		recordingsExport,
		whenReady: idb.whenLoaded,
	};
}
