/**
 * Opensidian workspace definition — Yjs-backed virtual filesystem.
 *
 * Uses `filesTable` from `@epicenter/filesystem` as the sole table.
 * The workspace ID is `opensidian`.
 */

import { filesTable } from '@epicenter/filesystem';
import { defineWorkspace } from '@epicenter/workspace';

export const opensidianDefinition = defineWorkspace({
	id: 'opensidian',
	tables: { files: filesTable },
});
