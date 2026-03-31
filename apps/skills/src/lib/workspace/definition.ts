/**
 * Skills editor workspace definition — Yjs-backed virtual filesystem.
 *
 * Uses `filesTable` from `@epicenter/filesystem` as the sole table.
 * The workspace ID is `epicenter.skills`.
 */

import { filesTable } from '@epicenter/filesystem';
import { defineWorkspace } from '@epicenter/workspace';

export const skillsEditorDefinition = defineWorkspace({
	id: 'epicenter.skills',
	tables: { files: filesTable },
});
