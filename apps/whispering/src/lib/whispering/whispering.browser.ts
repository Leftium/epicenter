/**
 * Browser runtime client for Whispering.
 *
 * Picks the active doc (local or synced) at boot via `openActiveWhispering`,
 * then layers the one browser-specific action: the recordings export is
 * shared (the `#platform/download` seam turns it into a browser download
 * here and a Save dialog on desktop). The `whispering` singleton it exports
 * is consumed everywhere through the `#platform/whispering` seam.
 */

import { defineActions, satisfiesWorkspace } from '@epicenter/workspace';
import { defineRecordingsMarkdownExport } from './recordings-markdown-export';
import { openActiveWhispering } from './whispering.active';

export function openWhispering() {
	const { workspace, whenReady, collaboration } =
		openActiveWhispering('OpenAI');

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
