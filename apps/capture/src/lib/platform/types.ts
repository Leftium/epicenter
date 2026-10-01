/**
 * The seam between the Capture UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf reaches a
 * real directory through the host's folder bridge; the browser leaf opens a
 * logical folder in IndexedDB. Neither leaf imports a native module.
 */
import type { FileTable, FolderFiles, FolderGit } from '@epicenter/app/files';
import type { CaptureFields } from '@epicenter/capture';

/** The folder surface Capture uses. */
export type CaptureFolder = {
	readonly tables: {
		readonly captures: Pick<
			FileTable<CaptureFields>,
			'list' | 'get' | 'create' | 'writeSource' | 'delete'
		>;
	};
	/**
	 * Conditional writes of exact source follow the folder's history policy.
	 */
	readonly files: Pick<FolderFiles, 'read' | 'write'>;
	readonly git: Pick<FolderGit, 'snapshot' | 'subscribe' | 'commit'>;
};

/** Where the captures are, in terms a person can act on. */
export type CaptureLocation =
	| { readonly kind: 'browser' }
	/** An ordinary directory; `path` is its canonical absolute path. */
	| { readonly kind: 'directory'; readonly path: string };

/** The page's answer to a quit: go ahead, or stay open. */
export type QuitAnswer = (answer: 'proceed' | 'cancel') => Promise<void>;

export type CaptureHost = {
	readonly folder: CaptureFolder;
	readonly location: CaptureLocation;
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
	 * Runs `listener` when the desktop host process that owns the folder has
	 * stopped, so no save can be confirmed from this window again.
	 */
	onHostStopped(listener: () => void): () => void;
	/**
	 * Why quitting the desktop app cannot ask this window first, when it
	 * cannot. `undefined` when it can, and in a browser.
	 */
	readonly quitProtectionProblem: string | undefined;
	close(): Promise<void>;
};

export type OpenCaptureHost = () => Promise<CaptureHost>;
