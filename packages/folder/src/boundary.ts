/**
 * Domain methods share one storage API. Openers attach local-save accounting
 * before assembly gives it to files, tables, KV, batches, and the terminal.
 * Git keeps raw storage for its own publication sequence and captures.
 *
 * Browser applications use one IndexedDB transaction. Native applications
 * use ordered filesystem steps and report completed steps on later failure.
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

/** Storage used by domain methods; apply includes content-save accounting. */
export type FolderStorage = {
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
	apply(
		changes: readonly FileChange[],
	): Promise<Result<undefined, FileError | ApplyError>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

/** Raw storage also captures portable files for history. */
export type FileBoundary = FolderStorage & {
	capture(): Promise<Result<CapturedFiles, FileError>>;
};
