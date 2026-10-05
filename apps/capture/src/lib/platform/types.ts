/**
 * The seam between the Capture UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf attaches
 * to a real directory the desktop shell owns and answers the host when it
 * quits or restarts; the browser leaf opens a logical folder in OPFS and has
 * no such gate. Neither leaf imports the other's storage.
 */

import type { CaptureFields } from '@epicenter/capture';
import type {
	FileTable,
	FolderFiles,
	FolderGit,
	FolderLocation,
} from '@epicenter/folder';
import type { Departure } from './departure.svelte.js';

/**
 * The folder both leaves open. The browser names its scoped OPFS directory after
 * it; the desktop shell registers its directory under it.
 */
export const CAPTURE_FOLDER_ID = 'so.epicenter.capture';

/** The folder surface Capture uses. */
export type CaptureFolder = {
	readonly tables: {
		/**
		 * `edit` acquires the row editor an open capture is typed into, valid
		 * or not; each of its saves replaces the existing file whole and never
		 * creates one. `delete` removes only the reviewed version.
		 */
		readonly captures: Pick<
			FileTable<CaptureFields>,
			'list' | 'get' | 'create' | 'delete' | 'edit'
		>;
	};
	/**
	 * Exact source at a literal path, for copies, restores, and imports.
	 * `create` needs the path unoccupied and `replace` needs the file to be the
	 * one that was read.
	 */
	readonly files: Pick<FolderFiles, 'read' | 'create' | 'replace'>;
	readonly git: Pick<FolderGit, 'snapshot' | 'subscribe' | 'commit'>;
};

export type CaptureHost = {
	readonly folder: CaptureFolder;
	/** Where the folder says its files are. For showing; never joined onto. */
	readonly location: FolderLocation;
	/**
	 * Runs `listener` when files may have changed outside this page. A hint to
	 * reread, never file contents. Returns a stop function.
	 */
	onExternalChange(listener: () => void): () => void;
	/**
	 * Let go of this page's use of the folder after the collection has finished
	 * its intended saves. Calls that reach storage after this are refused.
	 * On the desktop the folder stays open for the shell and its other windows.
	 */
	close(): Promise<void>;
};

export type OpenCaptureHost = () => Promise<CaptureHost>;

/**
 * The host's question before it quits or restarts, for this window. Started
 * before the folder opens, so no round is missed. `undefined` in a browser,
 * where the leave warning covers a reload or a closed tab.
 */
export type OpenDeparture = () => Departure | undefined;
