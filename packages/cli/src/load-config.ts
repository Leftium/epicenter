/**
 * Workspace config loader.
 *
 * Loads `epicenter.config.ts` and collects every named export that quacks
 * like a workspace — an object with `whenReady` and `[Symbol.dispose]`.
 * Optional first-class fields (`actions`, `sync`, `awareness`) are read
 * directly off the export; the loader does no walking, no brand check, no
 * factory trickery.
 *
 * @example
 * ```typescript
 * // epicenter.config.ts:
 * //   const ydoc = new Y.Doc({ guid: 'notes' });
 * //   const idb = attachIndexedDb(ydoc);
 * //   const tables = attachTables(ydoc, schemas);
 * //   const actions = createNotesActions(tables);
 * //   const sync = attachSync(ydoc, { ... });
 * //   export const notes = {
 * //     whenReady: idb.whenLoaded,
 * //     actions,
 * //     sync,
 * //     [Symbol.dispose]() { ydoc.destroy(); },
 * //   };
 *
 * const { entries, dispose } = await loadConfig('/path/to/project');
 * try {
 *   for (const { name, workspace } of entries) {
 *     await workspace.whenReady;
 *     // dispatch actions, read sync, ...
 *   }
 * } finally {
 *   await dispose();
 * }
 * ```
 */

import type { Actions, SyncAttachment } from '@epicenter/workspace';
import { join, resolve } from 'node:path';

const CONFIG_FILENAME = 'epicenter.config.ts';

/**
 * Minimal awareness shape the CLI relies on. Users typically attach the
 * typed wrapper from `attachAwareness` (which exposes `.raw`) or the raw
 * y-protocols `Awareness`. Either shape works — `readPeers` does the
 * unwrapping.
 */
export type AwarenessLike = {
	clientID: number;
	getStates(): Map<number, unknown>;
};

/**
 * The shape every loaded workspace export must satisfy. Extra fields are
 * ignored by the CLI; only these are addressed.
 */
export type LoadedWorkspace = {
	readonly whenReady: Promise<unknown>;
	readonly actions?: Actions;
	readonly sync?: SyncAttachment;
	readonly awareness?: AwarenessLike | { raw: AwarenessLike };
	[Symbol.dispose](): void;
};

export type LoadConfigResult = {
	entries: { name: string; workspace: LoadedWorkspace }[];
	/**
	 * Release every workspace. Disposes each (synchronous) and awaits any
	 * `sync.whenDisposed` barriers so the CLI exits cleanly after closing
	 * sockets.
	 */
	dispose(): Promise<void>;
};

function isLoadedWorkspace(value: unknown): value is LoadedWorkspace {
	if (value == null || typeof value !== 'object') return false;
	const v = value as Record<PropertyKey, unknown>;
	if (!('whenReady' in v)) return false;
	const dispose = v[Symbol.dispose];
	return typeof dispose === 'function';
}

/**
 * Load workspace exports from an `epicenter.config.ts` file. Default
 * exports are skipped; use named exports so the CLI can address them by
 * name.
 *
 * @throws If no config file is found or no valid workspace exports are
 * detected.
 */
export async function loadConfig(targetDir: string): Promise<LoadConfigResult> {
	const configPath = join(resolve(targetDir), CONFIG_FILENAME);

	if (!(await Bun.file(configPath).exists())) {
		throw new Error(`No ${CONFIG_FILENAME} found in ${resolve(targetDir)}`);
	}

	const module = await import(Bun.pathToFileURL(configPath).href);

	const entries: LoadConfigResult['entries'] = [];
	for (const [name, value] of Object.entries(module)) {
		if (name === 'default') continue;
		if (!isLoadedWorkspace(value)) continue;
		entries.push({ name, workspace: value });
	}

	if (entries.length === 0) {
		throw new Error(
			`No workspaces found in ${CONFIG_FILENAME}.\n` +
				`Export an object with whenReady and [Symbol.dispose]:\n` +
				`  export const notes = {\n` +
				`    whenReady: idb.whenLoaded,\n` +
				`    actions, sync,\n` +
				`    [Symbol.dispose]() { ydoc.destroy(); },\n` +
				`  };`,
		);
	}

	return {
		entries,
		dispose: async () => {
			const barriers: Promise<unknown>[] = [];
			for (const { workspace } of entries) {
				if (workspace.sync?.whenDisposed) barriers.push(workspace.sync.whenDisposed);
				workspace[Symbol.dispose]();
			}
			await Promise.all(barriers);
		},
	};
}
