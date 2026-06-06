/**
 * An in-memory stand-in for the Tauri {@link Vault}, used by the `/demo` route so
 * the grid renders (and edits) in a plain browser with no native folder watcher.
 *
 * It is faithful, not a mock: it holds the same raw `.md` text the disk would, and
 * a save runs the REAL transforms ({@link editField} / {@link editBody}) then
 * re-parses and re-classifies through {@link readFolder}, exactly as the live vault
 * does after the watcher echoes a write back. So what you see and edit here is the
 * same pipeline production uses, minus the IO. The fixtures are inlined (the sample
 * vault lives outside the app root), so the route is self-contained.
 */

import { SvelteMap } from 'svelte/reactivity';
import { editBody, editField } from '$lib/core/serialize';
import { type FolderRead, readFolder } from '$lib/core/folder';
import { DEMO_MODEL_TEXT, DEMO_ROWS } from './fixtures';

export type DemoVault = ReturnType<typeof createDemoVault>;

/** Open the inlined fixtures as a live, editable in-memory vault. */
export function createDemoVault(name = 'sample-vault/drafts') {
	// filename -> raw markdown text, the same shape the disk holds. A save replaces
	// an entry's text, mirroring the watcher echoing a written file back.
	const entries = new SvelteMap<string, string>(
		DEMO_ROWS.map((row) => [row.name, row.content]),
	);

	const read = $derived.by((): FolderRead =>
		readFolder(
			[...entries].map(([name, content]) => ({ name, content })),
			DEMO_MODEL_TEXT,
		),
	);

	/** Apply one transform to a file's freshest text, the demo's analog of `write`. */
	function edit(name: string, transform: (raw: string) => string) {
		const raw = entries.get(name);
		if (raw === undefined) return;
		entries.set(name, transform(raw));
	}

	return {
		name,
		/** Set or clear one frontmatter field (`undefined` clears the key). */
		saveField(name: string, key: string, value: unknown) {
			edit(name, (raw) => editField(raw, key, value));
		},
		/** Replace a file's body, keeping its frontmatter intact. */
		saveBody(name: string, body: string) {
			edit(name, (raw) => editBody(raw, body));
		},
		/** The current classified folder. A pure read with no side effects. */
		get read(): FolderRead {
			return read;
		},
	};
}
