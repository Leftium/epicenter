/**
 * Workspace config loader.
 *
 * Loads `epicenter.config.ts` and collects every named export that quacks
 * like a workspace — an object with `whenReady` and `[Symbol.dispose]`.
 * Optional first-class fields (`actions`, `sync`, `awareness`) are read
 * directly off the export; the loader does no walking, no brand check, no
 * factory trickery.
 *
 * The recommended config style is to export the result of an `openFoo()`
 * factory directly — the same factory the app uses elsewhere — instead of
 * hand-rolling the workspace shape. The CLI consumes whichever fields the
 * factory exposes.
 *
 * @example
 * ```ts
 * // epicenter.config.ts
 * import { openFuji } from '@my/app/server';
 * export const fuji = openFuji({ auth, device });
 * ```
 *
 * Then on the consumer side:
 *
 * ```ts
 * await using config = await loadConfig('/path/to/project');
 * for (const { name, workspace } of config.entries) {
 *   await workspace.whenReady;
 *   // dispatch actions, read sync, ...
 * }
 * // sockets flushed automatically on scope exit
 * ```
 */

import type {
	Actions,
	Awareness,
	AwarenessState as WorkspaceAwarenessState,
	standardAwarenessDefs,
	SyncAttachment,
} from '@epicenter/workspace';
import { join, resolve } from 'node:path';

const CONFIG_FILENAME = 'epicenter.config.ts';

/**
 * The shape every loaded workspace export must satisfy. Extra fields are
 * ignored by the CLI; only these are addressed.
 *
 * `awareness` is the typed wrapper from `attachAwareness` — the CLI
 * expects `standardAwarenessDefs` so `state.device` carries `PeerDevice`
 * type without casts at consumption sites.
 */
export type LoadedWorkspace = {
	readonly whenReady: Promise<unknown>;
	readonly actions?: Actions;
	readonly sync?: SyncAttachment;
	readonly awareness?: Awareness<typeof standardAwarenessDefs>;
	[Symbol.dispose](): void;
};

/**
 * Per-peer awareness state typed against `standardAwarenessDefs`
 * (`{ device?: PeerDevice }`). Validated by the awareness wrapper at the
 * boundary, so `state.device` is `PeerDevice | undefined` without casts.
 */
export type AwarenessState = WorkspaceAwarenessState<
	typeof standardAwarenessDefs
>;

/** One named workspace export from `epicenter.config.ts`. */
export type WorkspaceEntry = {
	name: string;
	workspace: LoadedWorkspace;
};

export type LoadConfigResult = {
	entries: WorkspaceEntry[];
	/**
	 * Release every workspace. Calls each `workspace[Symbol.dispose]()`
	 * (synchronous) and awaits any `sync.whenDisposed` barriers so the CLI
	 * exits cleanly after closing sockets.
	 *
	 * Implements `[Symbol.asyncDispose]` so callers can write
	 * `await using config = await loadConfig(...)` per TC39 explicit
	 * resource management.
	 */
	[Symbol.asyncDispose](): Promise<void>;
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
	} else if (typeof (v.whenReady as { then?: unknown })?.then !== 'function') {
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

	const entries: WorkspaceEntry[] = [];
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
		async [Symbol.asyncDispose]() {
			const barriers: Promise<unknown>[] = [];
			for (const { workspace } of entries) {
				if (workspace.sync?.whenDisposed) barriers.push(workspace.sync.whenDisposed);
				workspace[Symbol.dispose]();
			}
			await Promise.all(barriers);
		},
	};
}
