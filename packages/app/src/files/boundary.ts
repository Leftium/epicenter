/**
 * The one file boundary per opened folder.
 *
 * Tables, KV, raw file access, the shell adapter, and incoming Git changes all
 * publish through `apply`. A browser adapter applies a batch in one IndexedDB
 * transaction. A native adapter applies ordered filesystem steps and reports
 * the steps that completed when a later one fails. It runs its batches and
 * captures one at a time, so a capture never observes one of its own batches
 * half applied.
 */
import type { Result } from 'wellcrafted/result';
import type { ApplyError, FileError } from './errors.js';
import type { FileExpectation, FileVersion } from './version.js';

export type FileRead = {
	readonly bytes: Uint8Array;
	readonly version: FileVersion;
};

export type FileListing = {
	/** Every regular file, including files outside portable scope. */
	readonly files: readonly { readonly path: string; readonly size: number }[];
	/** Every directory, including empty ones kept for the shell. */
	readonly directories: readonly string[];
};

/** One conditional step. Write versions are computed before publication starts. */
export type FileChange =
	| {
			readonly kind: 'write';
			readonly path: string;
			readonly bytes: Uint8Array;
			readonly version: FileVersion;
			readonly expected: FileExpectation;
	  }
	| {
			readonly kind: 'remove';
			readonly path: string;
			readonly expected: FileExpectation;
	  }
	| {
			/** Moves exact bytes; the destination must be absent. */
			readonly kind: 'move';
			readonly from: string;
			readonly to: string;
			readonly expected: FileExpectation;
	  };

/**
 * A condition on a directory's immediate filenames, checked where a batch
 * publishes and before any of its changes: inside the browser's readwrite
 * transaction, and inside the native boundary's batch queue. `check` receives
 * the sorted filenames, or none when the directory is absent. An error it
 * returns refuses the whole batch and nothing is written.
 *
 * `check` is synchronous because an IndexedDB transaction cannot wait on
 * other work. It is an internal input for file-backed tables, whose
 * attachment and destination rules depend on sibling filenames; it is not a
 * transaction API. A native guard orders this boundary's own batches only:
 * another program can still add a file after the check.
 */
export type DirectoryGuard<E> = {
	readonly directory: string;
	check(files: readonly string[]): Result<undefined, E>;
};

/** Every portable file's bytes, captured for a commit or status observation. */
export type CapturedFiles = {
	readonly files: ReadonlyMap<string, Uint8Array>;
	/** Paths enumeration found but whose bytes could not be read. */
	readonly unreadable: readonly {
		readonly path: string;
		readonly error: FileError;
	}[];
};

export type FileBoundary = {
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
	/** Publishes `changes` if every expectation, and `guard` when given, holds. */
	apply<E extends { readonly name: string } = never>(
		changes: readonly FileChange[],
		guard?: DirectoryGuard<E>,
	): Promise<Result<undefined, FileError | ApplyError | E>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
	/** All portable files, for commits and status. */
	capture(): Promise<Result<CapturedFiles, FileError>>;
};
