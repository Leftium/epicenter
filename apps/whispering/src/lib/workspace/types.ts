/**
 * The one boundary between Whispering and where its files live.
 *
 * The desktop app reaches a real directory through the folder host; a browser
 * tab keeps a logical folder in IndexedDB. Everything above this type is the
 * same code for both. Capabilities a storage cannot offer are `undefined`
 * here, not emulated: a browser folder has no directory to reveal.
 */
import type { FolderAccess } from '@epicenter/app/files';
import type { FolderTerminal } from '@epicenter/app/files/terminal';
import type { Result } from 'wellcrafted/result';
import type { CaptureDevice } from '../capture.js';
import type {
	TranscriptionSettings,
	whisperingDefinition,
} from '../definition.js';
import type { TranscriptionError } from '../transcription.js';
import type { TransformationError } from '../transformation.js';

export type WhisperingFolder = FolderAccess<typeof whisperingDefinition>;

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
	/** Files changed outside this page. A browser folder has no outside writer. */
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
