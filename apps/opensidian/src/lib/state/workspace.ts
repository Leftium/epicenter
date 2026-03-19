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
const ws = createWorkspace({
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

/** Per-file content document manager for opening/reading/writing file content. */
export const documents = ws.documents.files.content;

/**
 * Files table helper (`TableHelper<FileRow>`).
 *
 * Used for `.get()`, `.observe()`, and `.getAllValid()` on file rows.
 * Named `filesDb` to avoid collision with the `fs` filesystem export.
 */
export const filesDb = ws.tables.files;

/** SQLite full-text search index for file content. */
export const sqliteIndex = ws.extensions.sqliteIndex;

if (typeof window !== 'undefined') {
	(window as unknown as Record<string, unknown>).workspace = {
		fs,
		documents,
		filesDb,
		sqliteIndex,
	};
}
