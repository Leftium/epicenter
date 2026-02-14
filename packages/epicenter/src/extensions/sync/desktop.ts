import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import type { ExtensionContext } from '../../dynamic/extension';
import { defineExtension, type Lifecycle } from '../../shared/lifecycle';

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
 * import { persistence } from '@epicenter/hq/extensions/sync/desktop';
 * import { join } from 'node:path';
 *
 * const projectDir = '/my/project';
 * const epicenterDir = join(projectDir, '.epicenter');
 *
 * const workspace = createWorkspace({ name: 'Blog', tables: {...} })
 *   .withExtension('persistence', (ctx) => persistence(ctx, {
 *     filePath: join(epicenterDir, 'persistence', `${ctx.id}.yjs`),
 *   }));
 * ```
 */
export const persistence = (
	{ ydoc }: ExtensionContext,
	{ filePath }: PersistenceConfig,
) => {
	// Track async initialization via whenReady
	const whenReady = (async () => {
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

	return defineExtension({ whenReady });
};

/**
 * Filesystem persistence factory that returns a `Lifecycle`.
 *
 * Reads/writes a `.yjs` binary file using `Bun.file()` for read and
 * debounced `writeFileSync` for write.
 *
 * **Note**: This returns a raw `Lifecycle` (not an `Extension`), so it cannot
 * be used directly with `.withExtension()`. Use the `persistence` export above
 * for the extension-compatible version, or wrap this in `defineExtension()`.
 *
 * @example With the persistence extension pattern
 * ```typescript
 * import { persistence } from '@epicenter/hq/extensions/sync/desktop';
 * import { createSyncExtension } from '@epicenter/hq/extensions/sync';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', (ctx) => persistence(ctx, {
 *     filePath: join(epicenterDir, 'persistence', `${ctx.id}.yjs`),
 *   }))
 *   .withExtension('sync', createSyncExtension({
 *     url: 'ws://localhost:3913/workspaces/{id}/sync',
 *   }))
 * ```
 */
export function filesystemPersistence(options: {
	filePath: string;
}): (context: { ydoc: Y.Doc }) => Lifecycle {
	return ({ ydoc }): Lifecycle => {
		let saveTimeout: ReturnType<typeof setTimeout> | null = null;
		const { filePath } = options;

		const updateHandler = () => {
			if (saveTimeout) clearTimeout(saveTimeout);
			saveTimeout = setTimeout(() => {
				const state = Y.encodeStateAsUpdate(ydoc);
				writeFileSync(filePath, state);
			}, 500);
		};

		const whenReady = (async () => {
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
			whenReady,
			destroy: () => {
				if (saveTimeout) clearTimeout(saveTimeout);
				ydoc.off('update', updateHandler);
			},
		};
	};
}
