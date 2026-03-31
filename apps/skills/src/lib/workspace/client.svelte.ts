/**
 * Skills editor workspace infrastructure.
 *
 * Pure TypeScript—no Svelte runes. Creates the Yjs workspace,
 * filesystem abstraction, and extensions. Imported by both
 * fs-state.svelte.ts (for reactive wrappers) and components
 * that need direct infra access (Toolbar, ContentEditor).
 */

import {
	createSqliteIndex,
	createYjsFileSystem,
} from '@epicenter/filesystem';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { Bash } from 'just-bash';
import { createSkillsEditor } from './workspace';

export const ws = createSkillsEditor()
	.withExtension('persistence', indexeddbPersistence)
	.withWorkspaceExtension('sqliteIndex', createSqliteIndex());

/** Yjs-backed virtual filesystem with path-based operations. */
export const fs = createYjsFileSystem(
	ws.tables.files,
	ws.documents.files.content,
);

/**
 * Shell emulator backed by the Yjs virtual filesystem.
 *
 * Executes `just-bash` commands against the same `fs` used by the UI,
 * so files created via `echo "x" > /foo.md` are immediately visible
 * in the file tree. Shell state (env, cwd) resets between `exec()` calls.
 *
 * @example
 * ```typescript
 * const result = await bash.exec('echo "hello" > /greeting.md');
 * const cat = await bash.exec('cat /greeting.md');
 * console.log(cat.stdout); // "hello\n"
 * ```
 */
export const bash = new Bash({ fs, cwd: '/' });
