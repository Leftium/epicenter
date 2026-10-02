/**
 * Operation failures for file folders.
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told. A refusal before publication (`Conflict`, `Exists`, and
 * preparation failures) wrote nothing. `Partial` reports a multi-file operation
 * that stopped after some steps reached the folder.
 *
 * These describe acquiring and publishing files. Whether a row's text parses
 * and whether its fields conform are not failures of an operation: a snapshot
 * carries them as `parseError` and `issues` (ADR-0462).
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { FieldIssue, ParseError } from './reading.js';

export const FileError = defineErrors({
	InvalidPath: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The path '${path}' is not usable: ${reason}`,
		path,
		reason,
	}),
	/** The addressed file is absent. */
	NotFound: ({ path }: { path: string }) => ({
		message: `No file exists at '${path}'`,
		path,
	}),
	/** The create target or move destination is occupied. */
	Exists: ({ path }: { path: string }) => ({
		message: `The destination '${path}' is already occupied`,
		path,
	}),
	/** The current bytes differ from the captured baseline. This refusal wrote nothing. */
	Conflict: ({
		path,
		expectedSha256,
		actualSha256,
	}: {
		path: string;
		expectedSha256: string;
		actualSha256: string | undefined;
	}) => ({
		message:
			actualSha256 === undefined
				? `No file exists at '${path}' to match the captured SHA-256`
				: `The file at '${path}' does not match the captured SHA-256`,
		path,
		expectedSha256,
		actualSha256,
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

/**
 * Failures of reading a row or `kv.json` as text and of preparing a
 * structured write. None of them published anything. An address a folder does not admit is
 * `FileError.InvalidPath`, and an occupied destination is `FileError.Exists`:
 * a table has no naming or collision rule of its own (ADR-0462).
 */
export const TableError = defineErrors({
	/**
	 * Supplied values are undeclared, do not conform to their fields, are
	 * absent from a complete row, or cannot be copied or written to the file.
	 */
	InvalidValues: ({ issues }: { issues: readonly FieldIssue[] }) => ({
		message: `Supplied values do not conform: ${issues.map((issue) => issue.message).join('; ')}`,
		issues,
	}),
	/**
	 * The current source does not parse, so no structured change was prepared,
	 * a row's body change included. Replace the complete source instead.
	 */
	Unparsed: ({ path, error }: { path: string; error: ParseError }) => ({
		message: `The source of '${path}' does not parse, so it cannot be updated: ${error.message}`,
		path,
		error,
	}),
	/** The source parses, but the change cannot be made without altering source it did not name. */
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

type TableErrorOf<TName extends TableError['name']> = Extract<
	TableError,
	{ name: TName }
>;

/** Storage failures are forwarded intact. Narrower storage signatures belong to their producers. */
export type TableEnumerationError = FileError;

/** Acquisition or UTF-8 decoding failed. A parse failure is the snapshot's `parseError`. */
export type TableReadError = FileError | TableErrorOf<'InvalidUtf8'>;

/** get recovers NotFound as Ok(undefined); it shares the storage read error family. */
export type TableGetError = TableReadError;

/** Storage publication or preparation of the supplied complete row failed. */
export type TableCreateError =
	| FileError
	| ApplyError
	| TableErrorOf<'InvalidValues'>;

/** Structured preparation adds its failures to acquisition and publication failures. */
export type TableUpdateError =
	| TableReadError
	| ApplyError
	| TableErrorOf<'InvalidValues' | 'Unparsed' | 'UnsupportedSource'>;

/** Complete source publication needs no parsing or field preparation. */
export type TableReplaceError = FileError | ApplyError;

/** Moving a captured row preserves the storage operation's failures. */
export type TableRenameError = FileError | ApplyError;

/** Removing a captured row preserves the storage operation's failures. */
export type TableDeleteError = FileError | ApplyError;

/** Every failure a table write can report. */
export type TableWriteError =
	| TableCreateError
	| TableUpdateError
	| TableReplaceError
	| TableRenameError
	| TableDeleteError;

/** Acquisition or UTF-8 decoding of kv.json failed. `get` recovers NotFound as Ok(undefined). */
export type KvReadError = FileError | TableErrorOf<'InvalidUtf8'>;

/**
 * Failures from a sparse kv.json write. `Unparsed` is current source that is
 * not one JSON object; `UnsupportedSource` is an object the supplied keys
 * cannot be assigned in safely.
 */
export type KvWriteError =
	| KvReadError
	| ApplyError
	| TableErrorOf<'InvalidValues' | 'Unparsed' | 'UnsupportedSource'>;

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
