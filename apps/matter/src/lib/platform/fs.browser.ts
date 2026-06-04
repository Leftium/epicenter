/**
 * Browser impl of `#platform/fs`, backed by the File System Access API
 * (`showDirectoryPicker`). Available in Chromium browsers; absent in Firefox /
 * Safari, where `available` is `false` and the UI disables folder-opening.
 *
 * The Tauri impl (`fs.tauri.ts`) is never resolved on the web, so no
 * `@tauri-apps/*` code reaches the browser bundle.
 */

import type { FolderEntry } from '$lib/model/folder';
import type { OpenedFolder, PlatformFs } from './types';

// The File System Access API is not in TypeScript's baseline lib.dom yet, so we
// declare the slice we use rather than casting to `any`. Only the read path.
type FileEntryHandle = { kind: 'file'; getFile(): Promise<File> };
type DirEntryHandle = { kind: 'directory' };
type DirHandle = {
	name: string;
	entries(): AsyncIterableIterator<[string, FileEntryHandle | DirEntryHandle]>;
};
type DirPicker = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<DirHandle>;

const picker = (
	globalThis as { showDirectoryPicker?: DirPicker }
).showDirectoryPicker;

const available = typeof picker === 'function';

async function openFolder(): Promise<OpenedFolder | null> {
	if (!picker) {
		throw new Error(
			'This browser cannot open folders. Use the desktop app or a Chromium browser.',
		);
	}

	let dir: DirHandle;
	try {
		dir = await picker({ mode: 'read' });
	} catch {
		// The user dismissed the picker (AbortError). Not an error to surface.
		return null;
	}

	const entries: FolderEntry[] = [];
	let modelText: string | undefined;
	for await (const [name, handle] of dir.entries()) {
		if (handle.kind !== 'file') continue;
		if (name === 'matter.json') {
			modelText = await (await handle.getFile()).text();
		} else if (name.endsWith('.md')) {
			entries.push({ path: name, content: await (await handle.getFile()).text() });
		}
	}

	return { name: dir.name, entries, modelText };
}

export const fs: PlatformFs = { openFolder, available };
