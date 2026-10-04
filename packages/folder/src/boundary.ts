/**
 * Domain methods share one storage API. Openers attach local-save accounting
 * before assembly gives it to files, tables, KV, and the terminal. Git keeps
 * raw storage for its own publication sequence and captures.
 *
 * `apply` takes ordered changes for Git publication, the terminal, and the
 * native transport. Files, tables, KV, and editors publish one change at a
 * time through `applyOne` (`storage.ts`), which restates the raw outcome.
 *
 * Every save of files, tables, KV, editors, and the terminal carries the
 * `Submission` it reserved, synchronously, when its public method was
 * entered: before it hashes, reads, or tells a listener anything. That is
 * the order the page asked for its saves in, whatever finishes first.
 *
 * Browser OPFS and native applications both use ordered filesystem steps and
 * report completed steps on later failure.
 */
import type { Result } from 'wellcrafted/result';
import type { ApplyError, FileError } from './errors.js';

export type FileRead = {
	readonly bytes: Uint8Array;
	readonly sha256: string;
};

export type FileListing = {
	/** Every regular file, including files outside portable scope. */
	readonly files: readonly { readonly path: string; readonly size: number }[];
	/** Every directory, including empty ones kept for the shell. */
	readonly directories: readonly string[];
};

/** A write owns its bytes before the asynchronous hash is computed. */
export type FileWriteIntent = { path: string; bytes: Uint8Array } & (
	| { kind: 'create' }
	| { kind: 'overwrite' }
	| { kind: 'replace'; expectedSha256: string }
);

/** The operation states its publication condition. Move destinations must be absent. */
export type FileChange =
	| (FileWriteIntent & { sha256: string })
	| { kind: 'remove'; path: string; expectedSha256?: string }
	| { kind: 'move'; from: string; to: string; expectedSha256?: string };

/** Every portable file's bytes, captured for a commit or status observation. */
export type CapturedFiles = {
	readonly files: ReadonlyMap<string, Uint8Array>;
	/** Paths enumeration found but whose bytes could not be read. */
	readonly unreadable: readonly {
		readonly path: string;
		readonly error: FileError;
	}[];
};

declare const reserved: unique symbol;

/**
 * A save's place in this page's order of saves, taken by `reserveSubmission`
 * (`storage.ts`) when a public method that saves is entered.
 */
export type Submission = number & { readonly [reserved]: true };

/** What every storage serves besides publication. */
type StorageAccess = {
	list(): Promise<Result<FileListing, FileError>>;
	/** Immediate children of a directory: files and subdirectories by name. */
	children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>>;
	read(path: string): Promise<Result<FileRead, FileError>>;
	/** Reads several files; a missing or unreadable path is reported by path. */
	readMany(
		paths: readonly string[],
	): Promise<Result<Map<string, Result<FileRead, FileError>>, FileError>>;
	/** Stable bytes for consumption; later path changes do not alter them. */
	open(path: string): Promise<Result<Blob, FileError>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

/** Storage used by domain methods; apply includes content-save accounting. */
export type FolderStorage = StorageAccess & {
	/**
	 * Publish `changes` in `submission`'s place. A storage whose saves can
	 * reach the folder out of order refuses one that arrives after a later
	 * save of this page landed on its path; one that publishes in call order
	 * needs no number.
	 */
	apply(
		changes: readonly FileChange[],
		submission: Submission,
	): Promise<Result<undefined, FileError | ApplyError>>;
};

/**
 * Raw storage also captures portable files for history. Git publishes
 * through it in its own sequence, so its saves take no page number.
 */
export type FileBoundary = StorageAccess & {
	apply(
		changes: readonly FileChange[],
		submission?: Submission,
	): Promise<Result<undefined, FileError | ApplyError>>;
	capture(): Promise<Result<CapturedFiles, FileError>>;
};
