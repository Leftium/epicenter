/**
 * The one boundary between Whispering and where its files live.
 *
 * The desktop app reaches a real directory through the folder host; a browser
 * tab keeps a logical folder in IndexedDB. Everything above this type is the
 * same code for both. Capabilities a storage cannot offer are `undefined`
 * here, not emulated: a browser folder has no directory to reveal.
 */
import type {
	FolderAccess,
	FolderTerminal,
	OpenFolderError,
} from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { CaptureDevice } from '../capture.js';
import type {
	TranscriptionSettings,
	whisperingDefinition,
} from '../definition.js';
import type { TranscriptionError } from '../transcription.js';
import type { TransformationError } from '../transformation.js';

export type WhisperingFolder = FolderAccess<typeof whisperingDefinition>;

/**
 * Why no workspace could be opened. The message is what the person is shown.
 * Neither storage is tried in place of the other: a browser folder that is
 * refused is not replaced by a desktop one, and a desktop folder that cannot
 * be reached is not replaced by browser storage.
 */
export const WorkspaceError = defineErrors({
	/** This browser's storage refused or could not be opened. */
	BrowserFolder: ({ refusal }: { refusal: OpenFolderError }) => ({
		message:
			refusal.name === 'InsideTauri'
				? 'This window is inside a desktop app, but Whispering’s folder host is not running, so there is no folder to open. Browser storage is not used inside a desktop app.'
				: refusal.name === 'NoIndexedDb'
					? 'This browser has no storage Whispering can use (IndexedDB is unavailable here), so the folder cannot be opened.'
					: refusal.message,
		refusal,
	}),
	/** The desktop folder host did not answer when the window opened. */
	FolderHost: ({ reason }: { reason: string }) => ({
		message: `Whispering’s folder host could not be reached, so the folder cannot be opened: ${reason}`,
		reason,
	}),
});
export type WorkspaceError = InferErrors<typeof WorkspaceError>;

/** Repeatable failures a debug desktop shell can arm. */
export type InjectionState = {
	readonly rowWrites: number;
	readonly audioWrites: number;
	readonly commitsBlocked: boolean;
};

export type CloseDecision = 'proceed' | 'asking' | 'cancel';

export type Workspace = {
	readonly kind: 'native' | 'browser';
	readonly folder: WhisperingFolder;
	/** Where the files are: an absolute directory, or a description of browser storage. */
	readonly location: string;
	readonly terminal: FolderTerminal;
	/** One line under the terminal's title saying what kind of terminal this is. */
	readonly terminalNote: string;
	/** What this session records from. Fixed when the workspace opens. */
	readonly capture: CaptureDevice;
	/** Something the person should know about capture, such as a refused fixture. */
	readonly captureNotice: string | undefined;
	/**
	 * Files changed, so read again. On the desktop this is any program writing
	 * the directory; in a browser it is a save from this tab or another tab.
	 */
	onExternalChange(listener: () => void): () => void;
	/** Show the folder in the system file manager; a problem is returned as text. */
	readonly reveal: (() => Promise<string | undefined>) | undefined;
	transcribe(request: {
		readonly audioPath: string;
		readonly baseUrl: string;
		readonly model: string;
	}): Promise<Result<{ text: string }, TranscriptionError>>;
	/**
	 * Send a prompt and a transcript to a chat endpoint and return its text.
	 * Uses the same device key as transcription. Nothing is written by this.
	 */
	transform(request: {
		readonly baseUrl: string;
		readonly model: string;
		readonly prompt: string;
		readonly input: string;
	}): Promise<Result<{ text: string }, TransformationError>>;
	/** Where transformation requests leave from, and what that requires of the endpoint. */
	readonly transformNote: string;
	readonly credential: {
		/** Where the key is kept, for the settings form. */
		readonly storedIn: string;
		/** Set when the key cannot be changed from the app. */
		readonly readOnlyReason: string | undefined;
		present(): Promise<boolean>;
		set(key: string): Promise<string | undefined>;
	};
	/**
	 * The desktop shell asks before it closes the window or quits, because only
	 * the page knows what is unsaved. The page answers `proceed` to let it
	 * close, `asking` while it shows its own confirmation, or `cancel` to stay
	 * open. Undefined in a browser tab, where the browser owns leaving.
	 */
	readonly closing:
		| {
				onRequest(listener: () => void): () => void;
				answer(decision: CloseDecision): Promise<void>;
				/**
				 * The shell tried to close but the folder host is gone, so it could
				 * not ask through it. The page must keep the window and say why.
				 */
				onRequestWithoutHost(listener: () => void): () => void;
				/** With the host gone, the one way to tell the shell to quit. */
				quitWithoutHost(): void;
		  }
		| undefined;
	/** Written to `kv.json` when the folder has none. */
	readonly initialSettings: TranscriptionSettings;
	/** Whether debug controls (paused autosave) are offered. */
	readonly debugControls: boolean;
	/** Failure injection, in a debug desktop shell only. */
	readonly injection:
		| {
				state(): Promise<InjectionState>;
				arm(change: Partial<InjectionState>): Promise<InjectionState>;
		  }
		| undefined;
	close(): Promise<void>;
};
