/**
 * The seam between the notes UI and where its folder lives.
 *
 * `#platform/notes-host` resolves at build time. The desktop leaf reaches a
 * real directory through the folder host's bridge; the browser leaf opens a
 * logical folder in IndexedDB. Neither leaf imports a native module, and the
 * UI never asks which one it has except through the optional capabilities
 * below.
 */
import type { Folder, FolderGit } from '@epicenter/app/files';
import type { FaultState, Faults, FileRevision } from '../bridge/contract.js';
import type { honeycrispDefinition } from '../data.js';

type Definition = typeof honeycrispDefinition;

/** The folder surface the notes UI uses. Remotes are outside this app. */
export type NotesFolder = Pick<
	Folder<Definition>,
	'tables' | 'kv' | 'files'
> & {
	readonly git: Pick<
		FolderGit,
		'snapshot' | 'subscribe' | 'status' | 'commit' | 'log' | 'diff'
	>;
};

export type TerminalRun = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

/** A shell whose working directory is the notes folder. */
export type NotesTerminal = {
	/** The working directory the next command starts in, as shown in the prompt. */
	readonly cwd: string;
	/** One line describing what the shell is, for the terminal's header. */
	readonly description: string;
	exec(command: string): Promise<TerminalRun>;
};

export type NotesHost = {
	readonly folder: NotesFolder;
	readonly terminal: NotesTerminal;
	/** Where the notes are, in words a person can act on: a path, or the browser. */
	readonly location: string;
	/** Open the notes directory in the system file manager; absent in a browser. */
	readonly reveal: (() => Promise<string | undefined>) | undefined;
	/** Per-file Git history; absent where the folder cannot list it by path. */
	readonly history:
		| {
				log(path: string, depth: number): Promise<FileRevision[]>;
				show(oid: string, path: string): Promise<string>;
		  }
		| undefined;
	/** Fault injection for acceptance testing; absent unless the host enables it. */
	readonly faults:
		| {
				get(): Promise<FaultState>;
				set(faults: Partial<Faults>): Promise<FaultState>;
		  }
		| undefined;
	/** Runs `listener` when files changed outside this page. Returns a stop function. */
	onExternalChange(listener: () => void): () => void;
	/** Runs `listener` when a close or quit was held back. Returns a stop function. */
	onCloseRequested(listener: (reason?: 'unavailable') => void): () => void;
	/** Tell the shell the page agrees to quit. A browser has nothing to tell. */
	quit(): Promise<void>;
	close(): Promise<void>;
};

export type OpenNotesHost = () => Promise<NotesHost>;
