/**
 * Workspace config loader.
 *
 * Loads `epicenter.config.ts` and collects every named export that is an
 * opened `DocumentHandle` (returned by `createDocumentFactory(...).open(id)`).
 * The export name becomes the root of the dot-path used by `epicenter list`
 * and `epicenter run`.
 *
 * @example
 * ```typescript
 * // epicenter.config.ts:
 * //   const notesFactory = createDocumentFactory((id) => ({ ydoc, tables, ... }));
 * //   export const notes = notesFactory.open('notes');
 *
 * const { entries, dispose } = await loadConfig('/path/to/project');
 * try {
 *   // ... walk entries, invoke actions ...
 * } finally {
 *   await dispose();
 * }
 * ```
 */

import {
	isDocumentHandle,
	type DocumentBundle,
	type DocumentHandle,
} from '@epicenter/workspace';
import { join, resolve } from 'node:path';

const CONFIG_FILENAME = 'epicenter.config.ts';

export type LoadConfigResult = {
	/** Handles keyed by export name. The name is the dot-path root. */
	entries: { name: string; handle: DocumentHandle<DocumentBundle> }[];
	/**
	 * Release every handle. Calls `.dispose()` on each and awaits any
	 * `whenDisposed` barrier exposed on the underlying bundle, so the CLI
	 * exits cleanly after flushing persistence / closing sync sockets.
	 */
	dispose(): Promise<void>;
};

/**
 * Load opened document handles from an `epicenter.config.ts` file.
 * Default exports are skipped; use named exports so the CLI can address
 * them by name.
 *
 * @throws If no config file is found or no valid handle exports are detected.
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
		if (!isDocumentHandle(value)) continue;
		entries.push({ name, handle: value });
	}

	if (entries.length === 0) {
		throw new Error(
			`No document handles found in ${CONFIG_FILENAME}.\n` +
				`Export an opened handle — not the factory:\n` +
				`  const notesFactory = createDocumentFactory((id) => ({ ydoc, tables, ... }));\n` +
				`  export const notes = notesFactory.open('notes');`,
		);
	}

	return {
		entries,
		dispose: async () => {
			const barriers: Promise<void>[] = [];
			for (const { handle } of entries) {
				if (handle.whenDisposed) barriers.push(handle.whenDisposed);
				handle.dispose();
			}
			await Promise.all(barriers);
		},
	};
}

