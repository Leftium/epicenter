import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { defineExports, type ExtensionContext } from '../../dynamic/extension';
import type { Lifecycle } from '../../shared/lifecycle';
import type { KvField, TableDefinition } from '../../dynamic/schema';

/**
 * Configuration for the persistence extension.
 */
export type PersistenceConfig = {
	/** Absolute path to the .yjs file for storing YJS state. */
	filePath: string;
};

/**
 * YJS document persistence extension using the filesystem.
 * Stores the YDoc as a binary file.
 *
 * **Platform**: Node.js/Desktop (Tauri, Electron, Bun)
 *
 * **How it works**:
 * 1. Creates parent directory if it doesn't exist
 * 2. Loads existing state from the specified filePath on startup
 * 3. Auto-saves to disk on every YJS update (synchronous to ensure data is persisted before process exits)
 *
 * @example
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 * import { persistence } from '@epicenter/hq/extensions/persistence';
 * import { join } from 'node:path';
 *
 * const projectDir = '/my/project';
 * const epicenterDir = join(projectDir, '.epicenter');
 *
 * const workspace = createWorkspace({ name: 'Blog', tables: {...} })
 *   .withExtensions({
 *     persistence: (ctx) => persistence(ctx, {
 *       filePath: join(epicenterDir, 'persistence', `${ctx.id}.yjs`),
 *     }),
 *   });
 * ```
 */
export const persistence = <
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(
	{ ydoc }: ExtensionContext<TTableDefinitions, TKvFields>,
	{ filePath }: PersistenceConfig,
) => {
	// Track async initialization via whenSynced
	const whenSynced = (async () => {
		await mkdir(path.dirname(filePath), { recursive: true });

		// Try to load existing state from disk using Bun.file
		// No need to check existence first - just try to read and handle failure
		const file = Bun.file(filePath);
		try {
			// Use arrayBuffer() to get a fresh, non-shared buffer for Yjs
			const savedState = await file.arrayBuffer();
			// Convert to Uint8Array for Yjs
			Y.applyUpdate(ydoc, new Uint8Array(savedState));
			// console.log(`[Persistence] Loaded workspace from ${filePath}`);
		} catch {
			// File doesn't exist or couldn't be read - that's fine, we'll create it on first update
			// console.log(`[Persistence] Creating new workspace at ${filePath}`);
		}

		// Auto-save on every update using synchronous write
		// This ensures data is persisted before the process can exit
		// The performance impact is minimal for typical YJS update sizes
		ydoc.on('update', () => {
			const state = Y.encodeStateAsUpdate(ydoc);
			writeFileSync(filePath, state);
		});
	})();

	return defineExports({ whenSynced });
};

/**
 * Filesystem persistence factory for use with `ySweetSync`.
 *
 * Returns a function `(ydoc: Y.Doc) => Lifecycle` that reads/writes a `.yjs` binary file.
 * Uses `Bun.file()` for read, debounced `writeFileSync` for write.
 *
 * @example
 * ```typescript
 * import { filesystemPersistence } from '@epicenter/hq/extensions/persistence/desktop';
 * import { directAuth, ySweetSync } from '@epicenter/hq/extensions/y-sweet-sync';
 *
 * sync: ySweetSync({
 *   auth: directAuth('http://localhost:8080'),
 *   persistence: filesystemPersistence({ filePath: '/path/to/workspace.yjs' }),
 * })
 * ```
 */
export function filesystemPersistence(
	options: { filePath: string },
): (ydoc: Y.Doc) => Lifecycle {
	return (ydoc: Y.Doc): Lifecycle => {
		let saveTimeout: ReturnType<typeof setTimeout> | null = null;
		const { filePath } = options;

		const updateHandler = () => {
			if (saveTimeout) clearTimeout(saveTimeout);
			saveTimeout = setTimeout(() => {
				const state = Y.encodeStateAsUpdate(ydoc);
				writeFileSync(filePath, state);
			}, 500);
		};

		const whenSynced = (async () => {
			await mkdir(path.dirname(filePath), { recursive: true });

			const file = Bun.file(filePath);
			try {
				const savedState = await file.arrayBuffer();
				Y.applyUpdate(ydoc, new Uint8Array(savedState));
			} catch {
				// File doesn't exist — will be created on first update
			}

			ydoc.on('update', updateHandler);
		})();

		return {
			whenSynced,
			destroy: () => {
				if (saveTimeout) clearTimeout(saveTimeout);
				ydoc.off('update', updateHandler);
			},
		};
	};
}
