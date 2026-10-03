/**
 * The seam between the notes UI and where its folder lives.
 *
 * `#platform/notes-host` resolves at build time. The desktop leaf opens the
 * folder the desktop shell owns and uses the shell's own commands, including
 * its real `/bin/sh`; the browser leaf opens a folder in IndexedDB with the
 * folder's emulated shell. The UI never asks which one it has except through
 * the optional capabilities below.
 */
import { APPS } from '@epicenter/constants/apps';
import type { Folder, FolderFiles, FolderGit } from '@epicenter/folder';
import type { honeycrispDefinition } from '../data.js';

type Definition = typeof honeycrispDefinition;

/**
 * The folder both leaves open. The browser names its IndexedDB database after
 * it; the desktop shell registers its directory under it (`SCOPE` in
 * `src-tauri/src/root.rs`).
 */
export const HONEYCRISP_FOLDER_ID = APPS.HONEYCRISP.id;

/**
 * The folder surface the notes UI uses. Tables are read as listings and
 * create new rows; a structured change to a row goes through that table's
 * row editor (`edit`), which saves the complete canonical document. The notes
 * table also reads a file being repaired with `inspect`. Every other change
 * to a file goes through `files`, on a capture. The folder says when files
 * changed, as a hint to read again. Remotes are outside this app.
 */
export type NotesFolder = {
	tables: {
		notes: Pick<
			Folder<Definition>['tables']['notes'],
			'list' | 'inspect' | 'create' | 'edit'
		>;
		folders: Pick<
			Folder<Definition>['tables']['folders'],
			'list' | 'create' | 'edit'
		>;
	};
	files: Pick<
		FolderFiles,
		| 'list'
		| 'read'
		| 'create'
		| 'replace'
		| 'move'
		| 'remove'
		| 'mkdir'
		| 'rmdir'
	>;
	git: Pick<FolderGit, 'snapshot' | 'subscribe' | 'status' | 'commit' | 'log'>;
	onFilesChanged: Folder<Definition>['onFilesChanged'];
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

/** One commit that changed a file. */
export type FileRevision = {
	readonly oid: string;
	readonly subject: string;
	/** Seconds since the epoch. */
	readonly timestamp: number;
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
	close(): Promise<void>;
};

/** What answering a close needs from the notes state. */
export type ClosableNotes = {
	/**
	 * Stop taking input and actions. Returns the release, for a close that was
	 * declined or refused.
	 */
	fenceInput(): () => void;
	/** Try to save every draft. Resolves how many still cannot be closed safely. */
	settleAll(): Promise<number>;
};

/**
 * Open the notes: acquire the folder, then build the notes state over it.
 *
 * The desktop leaf arranges close consent around this. It registers with the
 * shell before acquiring the folder, and from the moment the folder is held
 * it answers every window close and quit: input is fenced, drafts are saved,
 * and `askToDiscard` decides the rest. A browser tab has no shell to answer;
 * its leave guards are the page's own.
 */
export type OpenNotes = <TNotes extends ClosableNotes>(options: {
	/** Build the notes state over the opened folder. */
	create(host: NotesHost): Promise<TNotes>;
	/** Ask whether to discard `remaining` unsaved drafts and quit. */
	askToDiscard(remaining: number): Promise<boolean>;
	/** An answer to a close could not be sent; the close stays held. */
	report(cause: unknown): void;
}) => Promise<TNotes>;
