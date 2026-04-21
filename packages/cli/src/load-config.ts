/**
 * Workspace config loader.
 *
 * Loads `epicenter.config.ts` and collects every named export that is an
 * opened `DocumentHandle` (returned by `defineDocument(...).open(id)`).
 * The export name becomes the root of the dot-path used by `epicenter list`
 * and `epicenter run`.
 *
 * @example
 * ```typescript
 * // epicenter.config.ts:
 * //   const notesFactory = defineDocument((id) => ({ ydoc, tables, ... }));
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

import type { DocumentBundle, DocumentHandle } from '@epicenter/workspace';
import { join, resolve } from 'node:path';

const CONFIG_FILENAME = 'epicenter.config.ts';

export type ConfigEntry = {
	/** Export name in `epicenter.config.ts` — root of the dot-path. */
	name: string;
	/** Opened document handle. */
	handle: DocumentHandle<DocumentBundle>;
};

export type LoadConfigResult = {
	/** Absolute path to the directory containing epicenter.config.ts. */
	configDir: string;
	/** Handles keyed by export name. */
	entries: ConfigEntry[];
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
 * @param targetDir - Directory containing epicenter.config.ts.
 * @throws If no config file is found or no valid handle exports are detected.
 */
export async function loadConfig(targetDir: string): Promise<LoadConfigResult> {
	const configDir = resolve(targetDir);
	const configPath = join(configDir, CONFIG_FILENAME);

	if (!(await Bun.file(configPath).exists())) {
		throw new Error(`No ${CONFIG_FILENAME} found in ${configDir}`);
	}

	const module = await import(Bun.pathToFileURL(configPath).href);

	const entries: ConfigEntry[] = [];

	for (const [name, value] of Object.entries(module)) {
		if (name === 'default') continue;
		if (!isDocumentHandle(value)) continue;
		entries.push({ name, handle: value });
	}

	if (entries.length === 0) {
		throw new Error(
			`No document handles found in ${CONFIG_FILENAME}.\n` +
				`Export an opened handle — not the factory:\n` +
				`  const notesFactory = defineDocument((id) => ({ ydoc, tables, ... }));\n` +
				`  export const notes = notesFactory.open('notes');`,
		);
	}

	return {
		configDir,
		entries,
		dispose: () => disposeEntries(entries),
	};
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * A `DocumentHandle` exposes `ydoc` (via its bundle prototype), an own
 * `dispose()` function and an own `[Symbol.dispose]`. A bare factory fails
 * all three checks; this keeps factories out of the loader with a helpful
 * error path upstream.
 */
function isDocumentHandle(
	value: unknown,
): value is DocumentHandle<DocumentBundle> {
	if (value == null || typeof value !== 'object') return false;
	const record = value as Record<string | symbol, unknown>;
	return (
		'ydoc' in record &&
		typeof record.dispose === 'function' &&
		typeof record[Symbol.dispose] === 'function'
	);
}

async function disposeEntries(entries: ConfigEntry[]): Promise<void> {
	const barriers: Promise<void>[] = [];
	for (const { handle } of entries) {
		const bundle = Object.getPrototypeOf(handle) as DocumentBundle;
		if (bundle?.whenDisposed) barriers.push(bundle.whenDisposed);
		handle.dispose();
	}
	await Promise.all(barriers);
}
