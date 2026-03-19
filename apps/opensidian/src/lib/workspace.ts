import {
	createSqliteIndex,
	createYjsFileSystem,
	filesTable,
} from '@epicenter/filesystem';
import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';

/**
 * Opensidian workspace infrastructure.
 *
 * Pure TypeScript---no Svelte runes. Creates the Yjs workspace,
 * filesystem abstraction, and extensions. Imported by both
 * fs-state.svelte.ts (for reactive wrappers) and components
 * that need direct infra access (Toolbar, ContentEditor).
 */
export const ws = createWorkspace({
	id: 'opensidian',
	tables: { files: filesTable },
})
	.withExtension('persistence', indexeddbPersistence)
	.withWorkspaceExtension('sqliteIndex', createSqliteIndex());

/** Yjs-backed virtual filesystem with path-based operations. */
export const fs = createYjsFileSystem(
	ws.tables.files,
	ws.documents.files.content,
);
