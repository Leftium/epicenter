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
 * Minimal awareness shape the CLI relies on — the structural subset of
 * y-protocols `Awareness`. Workspaces using the typed wrapper from
 * `attachAwareness` should pass `awareness.raw`, matching the existing
 * `attachSync({ awareness: awareness.raw, ... })` convention.
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
	readonly awareness?: AwarenessLike;
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

/**
 * Classify a named export.
 *
 *   - `workspace` — looks like a workspace and validates.
 *   - `invalid`   — has at least one workspace-shaped field (`whenReady`,
 *                   `[Symbol.dispose]`, `actions`, `sync`, `awareness`) but
 *                   is missing required fields. The user clearly intended a
 *                   workspace; the loader should fail loud naming the
 *                   export and what's wrong.
 *   - `unrelated` — no workspace-ish fields. Skipped silently so configs
 *                   can also export type aliases, helpers, constants, etc.
 */
type WorkspaceCheck =
	| { kind: 'workspace'; value: LoadedWorkspace }
	| { kind: 'invalid'; reasons: string[] }
	| { kind: 'unrelated' };

function classifyWorkspaceExport(value: unknown): WorkspaceCheck {
	if (value == null || typeof value !== 'object') return { kind: 'unrelated' };
	const v = value as Record<PropertyKey, unknown>;

	const hasWhenReady = 'whenReady' in v;
	const hasDispose = typeof v[Symbol.dispose] === 'function';
	const looksWorkspaceShaped =
		hasWhenReady ||
		hasDispose ||
		'actions' in v ||
		'sync' in v ||
		'awareness' in v;

	if (!looksWorkspaceShaped) return { kind: 'unrelated' };

	const reasons: string[] = [];
	if (!hasWhenReady) {
		reasons.push('missing `whenReady`');
	} else if (typeof (v.whenReady as { then?: unknown } | null)?.then !== 'function') {
		reasons.push('`whenReady` must be a Promise (or thenable)');
	}
	if (!hasDispose) reasons.push('missing `[Symbol.dispose]`');

	if (reasons.length > 0) return { kind: 'invalid', reasons };
	return { kind: 'workspace', value: value as LoadedWorkspace };
}

/**
 * Load workspace exports from an `epicenter.config.ts` file. Default
 * exports are skipped; use named exports so the CLI can address them by
 * name.
 *
 * @throws If the config file is missing, an export looks like a workspace
 * but is malformed, or no workspace exports are found at all.
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
		const check = classifyWorkspaceExport(value);
		if (check.kind === 'unrelated') continue;
		if (check.kind === 'invalid') {
			throw new Error(
				`Export \`${name}\` in ${CONFIG_FILENAME} looks like a workspace but is invalid:\n` +
					check.reasons.map((r) => `  - ${r}`).join('\n'),
			);
		}
		entries.push({ name, workspace: check.value });
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
