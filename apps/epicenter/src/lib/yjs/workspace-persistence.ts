import type { ExtensionContext } from '@epicenter/workspace';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import * as Y from 'yjs';

// ─────────────────────────────────────────────────────────────────────────────
// File Names
// ─────────────────────────────────────────────────────────────────────────────

const FILE_NAMES = {
	/** Full Y.Doc binary - sync source of truth */
	WORKSPACE_YJS: 'workspace.yjs',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Persistence Extension
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a workspace Y.Doc to disk as a binary file.
 *
 * The Y.Doc binary is the single source of truth for all workspace data
 * (tables, KV, etc.). It is saved on every Y.Doc update and loaded on startup.
 *
 * **Storage Layout:**
 * ```
 * {appLocalDataDir}/workspaces/{workspaceId}/
 * ├── definition.json   # Workspace metadata (name, icon, etc.)
 * └── workspace.yjs     # Y.Doc binary (source of truth)
 * ```
 *
 * @param ctx - The extension context (only `ydoc` and `id` are used)
 * @returns Flat extension with `whenReady` promise and `destroy` cleanup
 *
 * @example
 * ```typescript
 * const client = createWorkspace(definition)
 *   .withExtension('persistence', (ctx) => workspacePersistence(ctx));
 * ```
 */
export function workspacePersistence(ctx: ExtensionContext) {
	const { ydoc, id } = ctx;

	// For logging
	const logPath = `workspaces/${id}`;

	// Resolve paths once, cache the promise
	const pathsPromise = (async () => {
		const baseDir = await appLocalDataDir();
		const workspaceDir = await join(baseDir, 'workspaces', id);
		const workspaceYjsPath = await join(workspaceDir, FILE_NAMES.WORKSPACE_YJS);

		return { workspaceDir, workspaceYjsPath };
	})();

	// =========================================================================
	// Y.Doc Binary Persistence (workspace.yjs)
	// =========================================================================

	const saveYDoc = async () => {
		const { workspaceYjsPath } = await pathsPromise;
		try {
			const state = Y.encodeStateAsUpdate(ydoc);
			await writeFile(workspaceYjsPath, state);
		} catch (error) {
			console.error(
				`[WorkspacePersistence] Failed to save workspace.yjs:`,
				error,
			);
		}
	};

	// Attach Y.Doc update handler
	ydoc.on('update', saveYDoc);

	// =========================================================================
	// Return Lifecycle
	// =========================================================================

	return {
		whenReady: (async () => {
			const { workspaceDir, workspaceYjsPath } = await pathsPromise;

			// Ensure workspace directory exists
			await mkdir(workspaceDir, { recursive: true }).catch(() => {});

			// Load existing Y.Doc state from disk
			let isNewFile = false;
			try {
				const savedState = await readFile(workspaceYjsPath);
				Y.applyUpdate(ydoc, new Uint8Array(savedState));
				console.log(`[WorkspacePersistence] Loaded ${logPath}/workspace.yjs`);
			} catch {
				isNewFile = true;
				console.log(
					`[WorkspacePersistence] Creating new ${logPath}/workspace.yjs`,
				);
			}

			// Save initial state if new file
			if (isNewFile) {
				await saveYDoc();
			}
		})(),

		destroy() {
			ydoc.off('update', saveYDoc);
		},
	};
}
