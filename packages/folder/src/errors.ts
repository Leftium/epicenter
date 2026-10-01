/**
 * Operation failures for file folders.
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told. A refusal before publication (`Conflict`, `Exists`, and
 * validation failures) wrote nothing. `Partial` reports a multi-file operation
 * that stopped after some steps reached the folder.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { FileExpectation, FileVersion } from './version.js';

export const FileError = defineErrors({
	InvalidPath: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The path '${path}' is not usable: ${reason}`,
		path,
		reason,
	}),
	NotFound: ({ path }: { path: string }) => ({
		message: `No file exists at '${path}'`,
		path,
	}),
	Conflict: ({
		path,
		expected,
		actual,
	}: {
		path: string;
		expected: FileExpectation;
		actual: FileVersion | undefined;
	}) => ({
		message:
			expected === 'absent'
				? `A file already exists at '${path}'`
				: actual === undefined
					? `The file at '${path}' was removed after it was read`
					: `The file at '${path}' changed after it was read`,
		path,
		expected,
		actual,
	}),
	NotAFile: ({ path }: { path: string }) => ({
		message: `'${path}' is a directory, not a file`,
		path,
	}),
	NotADirectory: ({ path }: { path: string }) => ({
		message: `'${path}' is a file, not a directory`,
		path,
	}),
	DirectoryNotEmpty: ({ path }: { path: string }) => ({
		message: `The directory '${path}' is not empty`,
		path,
	}),
	Io: ({
		path,
		operation,
		cause,
	}: {
		path: string;
		operation: string;
		cause: unknown;
	}) => ({
		message: `Could not ${operation} '${path}': ${describe(cause)}`,
		path,
		operation,
		cause,
	}),
	Unconfirmed: ({
		path,
		operation,
		cause,
	}: {
		path: string;
		operation: string;
		cause: unknown;
	}) => ({
		message: `The folder host did not confirm ${operation} '${path}'; the operation may have completed: ${describe(cause)}`,
		path,
		operation,
		cause,
	}),
	Closed: () => ({ message: 'The folder is closed' }),
});
export type FileError = InferErrors<typeof FileError>;

/** A step that reached, or failed to reach, the folder. */
export type FileStep =
	| { readonly kind: 'write'; readonly path: string }
	| { readonly kind: 'remove'; readonly path: string }
	| { readonly kind: 'move'; readonly from: string; readonly to: string };

export const ApplyError = defineErrors({
	/**
	 * A native multi-file operation stopped partway. `applied` steps reached the
	 * folder; nothing was rolled back. `failed` did not complete, and
	 * `notAttempted` never started.
	 */
	Partial: ({
		applied,
		failed,
		error,
		notAttempted,
	}: {
		applied: readonly FileStep[];
		failed: FileStep;
		error: FileError;
		notAttempted: readonly FileStep[];
	}) => ({
		message: `${applied.length} of ${applied.length + 1 + notAttempted.length} file steps completed before a failure: ${error.message}`,
		applied,
		failed,
		error,
		notAttempted,
	}),
});
export type ApplyError = InferErrors<typeof ApplyError>;

export const TableError = defineErrors({
	InvalidStem: ({ stem, reason }: { stem: string; reason: string }) => ({
		message: `The stem '${stem}' is not usable: ${reason}`,
		stem,
		reason,
	}),
	Exists: ({ path }: { path: string }) => ({
		message: `The destination '${path}' is already occupied`,
		path,
	}),
	Collision: ({ path, existing }: { path: string; existing: string }) => ({
		message: `The destination '${path}' collides with '${existing}' on case-insensitive filesystems`,
		path,
		existing,
	}),
	InvalidValues: ({
		issues,
	}: {
		issues: readonly { field: string; message: string }[];
	}) => ({
		message: `Supplied values do not conform: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ')}`,
		issues,
	}),
	UnsupportedSource: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The source of '${path}' cannot be changed safely: ${reason}`,
		path,
		reason,
	}),
	InvalidUtf8: ({ path }: { path: string }) => ({
		message: `'${path}' is not valid UTF-8 text`,
		path,
	}),
});
export type TableError = InferErrors<typeof TableError>;

export const BatchError = defineErrors({
	/** The callback threw while collecting. Nothing was published. */
	Threw: ({ cause }: { cause: unknown }) => ({
		message: `The batch callback threw, so nothing was published: ${describe(cause)}`,
		cause,
	}),
	/**
	 * The callback returned something. A batch collects mutations
	 * synchronously and returns `undefined`; a promise is not waited for.
	 * Nothing was published.
	 */
	Returned: ({ thenable }: { thenable: boolean }) => ({
		message: thenable
			? 'The batch callback returned a promise. A batch collects mutations synchronously, so nothing was published'
			: 'The batch callback returned a value. A batch callback returns undefined, so nothing was published',
		thenable,
	}),
});
export type BatchError = InferErrors<typeof BatchError>;

/** Failures from a table read. Absence is a successful `undefined`. */
export type TableReadError = FileError;

/** Failures from a table write. */
export type TableWriteError = TableError | FileError | ApplyError;

/**
 * Why a folder could not be opened. Every opener returns these; none throws
 * for a refusal, and none opens another storage instead.
 */
export const OpenFolderError = defineErrors({
	/** The definition declares something a file folder cannot keep. */
	InvalidDefinition: ({ reason }: { reason: string }) => ({
		message: `This definition cannot be opened as a folder: ${reason}`,
		reason,
	}),
	InvalidId: ({ id }: { id: string }) => ({
		message: `A folder needs a nonempty id, not '${id}'`,
		id,
	}),
	/** The desktop adapter was asked to open outside the desktop shell. */
	NotTauri: () => ({
		message:
			'This folder lives in the desktop app; it cannot be opened from a browser tab',
	}),
	/** The browser adapter was asked to open inside the desktop shell. */
	InsideTauri: () => ({
		message:
			'This page runs in the desktop app, whose folders are files on disk; browser storage is not opened there',
	}),
	/** No IndexedDB here: a server render, a worker without it, or a blocked origin. */
	NoIndexedDb: () => ({
		message:
			'Browser folders are stored in IndexedDB, which is not available here',
	}),
	/** A browser folder with a remote records pushed commits under a named author. */
	AuthorRequired: () => ({
		message:
			'A browser folder with a remote needs an explicit author for the commits it pushes',
	}),
	/** The directory an explicit opener was given cannot hold a folder. */
	InvalidRoot: ({ root, cause }: { root: string; cause: unknown }) => ({
		message: `The directory '${root}' cannot be opened as a folder: ${describe(cause)}`,
		root,
		cause,
	}),
	UnknownScope: ({ scope }: { scope: string }) => ({
		message: `The desktop app has no folder registered as '${scope}'`,
		scope,
	}),
	WindowNotPermitted: ({
		scope,
		window,
	}: {
		scope: string;
		window: string;
	}) => ({
		message: `The window '${window}' may not use the folder '${scope}'`,
		scope,
		window,
	}),
	Busy: ({ root }: { root: string }) => ({
		message: `Another Epicenter is already using the folder at ${root}. Quit the other Epicenter, then open this one again.`,
		root,
	}),
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `The folder could not be opened: ${describe(cause)}`,
		cause,
	}),
	ShuttingDown: () => ({ message: 'The desktop app is shutting down' }),
	/** This page and the desktop app were built for different folder contracts. */
	Incompatible: ({ host, page }: { host: number; page: number }) => ({
		message: `This page speaks folder protocol ${page}, but the desktop app speaks ${host}. Update the app, then open this again.`,
		host,
		page,
	}),
});
export type OpenFolderError = InferErrors<typeof OpenFolderError>;

export function describe(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	if (
		typeof cause === 'object' &&
		cause !== null &&
		'message' in cause &&
		typeof cause.message === 'string'
	)
		return cause.message;
	return String(cause);
}
