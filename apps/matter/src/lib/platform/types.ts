/**
 * Platform seam contracts. The `#platform/fs` subpath (declared in
 * `apps/matter/package.json` "imports") has a browser impl and a Tauri impl that
 * both conform to {@link PlatformFs}. Consumers import the bare `#platform/fs`
 * and the build selects the impl: web -> `default` (browser, File System Access
 * API), Tauri -> the `tauri` condition (a native command). The contract keeps
 * both impls in lockstep regardless of which one a build or the type checker
 * resolves.
 *
 * This file must stay free of `@tauri-apps/*` imports so it type-checks under the
 * web (default) resolution.
 */

import type { FolderEntry } from '$lib/model/folder';

/** A vault folder read off the local machine, ready for `readFolder`. */
export type OpenedFolder = {
	/** Display label for the folder (its basename / absolute path). */
	name: string;
	/** The folder's `.md` files (filename + raw content). */
	entries: FolderEntry[];
	/** Raw text of the folder's `matter.json`, if it has one. */
	modelText?: string;
};

/** Contract for `#platform/fs`: open and read a vault folder. */
export type PlatformFs = {
	/**
	 * Prompt for a folder and read its markdown + model. Resolves `null` when the
	 * user cancels the picker; rejects only on an actual read error.
	 */
	openFolder(): Promise<OpenedFolder | null>;
	/**
	 * Whether this platform can open a folder at all. `false` on browsers without
	 * the File System Access API, so the UI can disable the action and point the
	 * user at the desktop app.
	 */
	readonly available: boolean;
};
