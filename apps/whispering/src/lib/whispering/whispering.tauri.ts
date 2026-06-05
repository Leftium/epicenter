/**
 * Tauri runtime client for Whispering.
 *
 * Picks the active doc (local or synced) at boot via `openActiveWhispering`,
 * then layers the recordings export action (resolves to a native Save dialog
 * through the `#platform/download` seam). The `whispering` singleton it
 * exports is consumed everywhere through the `#platform/whispering` seam.
 */

import { defineActions, satisfiesWorkspace } from '@epicenter/workspace';
import { defineRecordingsMarkdownExport } from './recordings-markdown-export';
import { openActiveWhispering } from './whispering.active';

export function openWhispering() {
	const { workspace, whenReady, collaboration } =
		openActiveWhispering('parakeet');

	return satisfiesWorkspace({
		...workspace,
		actions: defineActions({
			...workspace.actions,
			recordings_export_markdown: defineRecordingsMarkdownExport(
				workspace.tables.recordings,
			),
		}),
		whenReady,
		collaboration,
	});
}

export const whispering = openWhispering();
