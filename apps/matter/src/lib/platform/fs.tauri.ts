/**
 * Tauri impl of `#platform/fs`. The folder picker is `tauri-plugin-dialog`; the
 * read is a native `read_folder` command (see `src-tauri/src/folder.rs`) that
 * reads whatever absolute path the dialog returns, so there is no
 * `tauri-plugin-fs` path-scope to configure.
 *
 * Resolved only under the `tauri` build condition, so `@tauri-apps/*` never
 * reaches the web bundle.
 */

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { FolderEntry } from '$lib/model/folder';
import type { OpenedFolder, PlatformFs } from './types';

/** Shape returned by the Rust `read_folder` command (serde camelCase). */
type ReadFolder = {
	name: string;
	entries: { name: string; content: string }[];
	modelText: string | null;
};

async function openFolder(): Promise<OpenedFolder | null> {
	const path = await open({
		directory: true,
		multiple: false,
		title: 'Open vault folder',
	});
	if (path === null || Array.isArray(path)) return null;

	const read = await invoke<ReadFolder>('read_folder', { path });
	const entries: FolderEntry[] = read.entries.map((e) => ({
		path: e.name,
		content: e.content,
	}));
	return { name: read.name, entries, modelText: read.modelText ?? undefined };
}

export const fs: PlatformFs = { openFolder, available: true };
