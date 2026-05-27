/**
 * Whispering's Tauri workspace opener.
 *
 * Conceptually this is `openWhisperingTauri()`: it creates the shared
 * `createWhisperingWorkspace()` model, then attaches Tauri-runtime resources
 * around it. The export name predates the repo-wide `open<App>Tauri` naming
 * convention.
 */

import { attachBroadcastChannel, attachIndexedDb } from '@epicenter/workspace';
import { attachRecordingMarkdownExport } from '$lib/recording-markdown-export';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { createWhisperingWorkspace } from './index';

export function openWhispering() {
	const workspace = createWhisperingWorkspace();

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	let recordingsExport:
		| ReturnType<typeof attachRecordingMarkdownExport>
		| undefined;

	function attachRecordingsExport(dir: string | null) {
		recordingsExport?.[Symbol.dispose]();
		recordingsExport = dir
			? attachRecordingMarkdownExport(
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

	async function rebuildRecordingMarkdownExport() {
		return (await recordingsExport?.rebuild()) ?? { deleted: 0, written: 0 };
	}

	return {
		...workspace,
		idb,
		rebuildRecordingMarkdownExport,
		whenReady: idb.whenLoaded,
	};
}
