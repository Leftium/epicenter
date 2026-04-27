/**
 * Workspace config loader.
 *
 * Contract:
 *
 *   A named export becomes a workspace if it implements [Symbol.dispose]
 *   (called at exit; the discriminator). If it also has:
 *
 *     whenReady: Promise         awaited before action invocations
 *     actions:   Actions          exposed to `run` and `list`
 *     sync:      SyncAttachment   enables --peer + `peers`
 *
 *   …the CLI uses them. Anything else is the factory's business.
 *
 * The recommended config style is to export the result of an `openFoo()`
 * factory directly — the same factory the app uses elsewhere — and let
 * the factory's return shape be the contract.
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
 *   if (workspace.whenReady) await workspace.whenReady;
 *   // dispatch actions, read sync, ...
 * }
 * // sockets flushed automatically on scope exit
 * ```
 */

import type {
	Actions,
	PeerAwarenessState,
	SyncAttachment,
} from '@epicenter/workspace';
import { join, resolve } from 'node:path';

export const CONFIG_FILENAME = 'epicenter.config.ts';

/**
 * Fields the CLI looks at on each workspace export. Only `[Symbol.dispose]`
 * is required (it's the discriminator); everything else is read when
 * present. Extra fields the factory returns are ignored.
 */
export type LoadedWorkspace = {
	/**
	 * Called by the CLI at exit. The discriminator — its presence is what
	 * marks the export as a workspace.
	 */
	[Symbol.dispose](): void;

	/** Awaited before any action invocation, if present. */
	readonly whenReady?: Promise<unknown>;

	/** Exposes runnable actions to `epicenter run` / `epicenter list`. */
	readonly actions?: Actions;

	/**
	 * Enables `--peer` targeting and `epicenter peers`. `attachSync(doc, { device })`
	 * carries presence inline — `peers()` / `find()` / `observe()` live on the
	 * SyncAttachment when the workspace was constructed with a `device`.
	 */
	readonly sync?: SyncAttachment;
};

/**
 * Per-peer awareness state under the standard `device` schema. Re-exported
 * from `@epicenter/workspace` for ergonomic consumption — `state.device` is
 * set synchronously at attach time, so consumers read
 * `state.device.{id,name,platform}` without `?.`.
 */
export type AwarenessState = PeerAwarenessState;

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
 * A workspace is anything with `[Symbol.dispose]`. That's the whole
 * contract — the factory's return shape is the source of truth for
 * everything else.
 */
function isLoadedWorkspace(value: unknown): value is LoadedWorkspace {
	return (
		value != null &&
		typeof value === 'object' &&
		typeof (value as Record<PropertyKey, unknown>)[Symbol.dispose] ===
			'function'
	);
}

/**
 * Load workspace exports from an `epicenter.config.ts` file. Default
 * exports are skipped; use named exports so the CLI can address them by
 * name.
 *
 * @throws If the config file is missing or no workspace exports are found.
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
		if (!isLoadedWorkspace(value)) continue;
		entries.push({ name, workspace: value });
	}

	if (entries.length === 0) {
		throw new Error(
			`No workspaces found in ${CONFIG_FILENAME}.\n` +
				`Export at least one named value implementing [Symbol.dispose] — ` +
				`typically the return of an openFoo() factory.`,
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
