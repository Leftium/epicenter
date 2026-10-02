/**
 * The seam between the Capture UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf attaches
 * to a real directory the desktop shell owns; the browser leaf opens a logical
 * folder in IndexedDB. Neither leaf imports the other's storage.
 */

import type { CaptureFields } from '@epicenter/capture';
import type {
	FileTable,
	FolderFiles,
	FolderGit,
	FolderLocation,
} from '@epicenter/folder';

/** The folder surface Capture uses. */
export type CaptureFolder = {
	readonly tables: {
		readonly captures: Pick<
			FileTable<CaptureFields>,
			'list' | 'get' | 'create' | 'replace' | 'delete'
		>;
	};
	/**
	 * Exact source at a literal path. `create` needs the path unoccupied and
	 * `replace` needs the file to be the one that was read; Capture takes no
	 * verb that overwrites.
	 */
	readonly files: Pick<FolderFiles, 'read' | 'create' | 'replace'>;
	readonly git: Pick<FolderGit, 'snapshot' | 'subscribe' | 'commit'>;
};

/** The page's answer to a quit: go ahead, or stay open. */
export type QuitAnswer = (answer: 'proceed' | 'cancel') => Promise<void>;

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
	 * Runs `listener` when the desktop app wants to quit. The app waits for
	 * `answer`. A request that arrived before a listener was attached is
	 * delivered when one is. A browser tab has no such request; its leave
	 * warning covers it.
	 */
	onQuitRequested(listener: (answer: QuitAnswer) => void): () => void;
	/**
	 * Runs `listener` when the Epicenter service that served this page has
	 * stopped. The folder is not that service's: saving carries on. What the
	 * page can no longer do is load anything more from it, a reload included.
	 * A folder that stops says so itself, as `closed` on its Git snapshot.
	 */
	onServiceStopped(listener: () => void): () => void;
	/**
	 * Why quitting the desktop app cannot ask this window first, when it
	 * cannot. `undefined` when it can, and in a browser.
	 */
	readonly quitProtectionProblem: string | undefined;
	/**
	 * Let go of this page's use of the folder. Saves already made still land.
	 * On the desktop the folder stays open for the shell and its other windows.
	 */
	close(): Promise<void>;
};

export type OpenCaptureHost = () => Promise<CaptureHost>;
