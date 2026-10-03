/**
 * The folder contract: everything an application names besides the opener.
 *
 * `@epicenter/folder`, `/browser`, `/tauri`, and `/bun` all export this
 * module unchanged, so code written against one entry type-checks against the
 * others, and an explicit entry never pulls the automatic selector into its
 * graph.
 *
 * This module is inert. Importing it opens nothing and loads no storage, no
 * Git implementation, and no runtime-specific module.
 */
import type { DataDefinition } from '@epicenter/definition';
import type { AccountIdentity } from '@epicenter/principal';
import type { Result } from 'wellcrafted/result';
import type { IndexedDbEnvironment } from './browser-store.js';
import type { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import type { GitRemote } from './git/backend.js';
import type { Author } from './git/objects.js';

export {
	type CreateRowOf,
	type DataDefinition,
	defineTable,
	field,
	type KvOf,
} from '@epicenter/definition';
export type {
	BatchFiles,
	BatchLanded,
	BatchReceipt,
	BatchRefusal,
	BatchTable,
	FolderBatch,
} from './batch.js';
export type { FileListing } from './boundary.js';
export type { IndexedDbEnvironment } from './browser-store.js';
export {
	type CapturedFile,
	type FileCapture,
	hashBytes,
	type TextCapture,
} from './capture.js';
export { defineFolder, type FolderTable } from './definition.js';
export {
	ApplyError,
	BatchError,
	FileError,
	type FileStep,
	type KvReadError,
	type KvWriteError,
	OpenFolderError,
	type TableCreateError,
	type TableDeleteError,
	type TableEnumerationError,
	TableError,
	type TableGetError,
	type TableReadError,
	type TableRenameError,
	type TableReplaceError,
	type TableUpdateError,
	type TableWriteError,
} from './errors.js';
export type { FolderFiles } from './files.js';
export type {
	Folder,
	FolderAccess,
	FolderGit,
	FolderGitOptions,
	FolderLocation,
} from './folder.js';
export type { GitRemote, PathStatus, StatusCode } from './git/backend.js';
export {
	GitError,
	type MergeConflict,
	MergeError,
	PullError,
} from './git/errors.js';
export type {
	Activity,
	Attempt,
	CommitAndPushResult,
	CommitOutcome,
	FetchOutcome,
	FilesObservation,
	GitSnapshot,
	MergeOutcome,
	Observation,
	PullOutcome,
	PushOutcome,
	SyncObservation,
} from './git/history.js';
export { commitSubject, escapePath, type PathChange } from './git/messages.js';
export type { Author, CommitSummary } from './git/objects.js';
export type { FileKv, KvReading, KvSnapshot } from './kv.js';
export { type KvMerge, type KvMergeInput, mergeKv } from './kv-merge.js';
export {
	frameSource,
	type PatchRefusal,
	patchSource,
	type SourceChange,
	type SourceFrame,
} from './markdown.js';
export { pathProblem, rowPath, rowStemOf } from './paths.js';
export type { DeepReadonly, FieldIssue, ParseError } from './reading.js';
export type {
	FileTable,
	TableListing,
	TableReading,
	TableSnapshot,
} from './table.js';
export type { FolderTerminal, TerminalResult } from './terminal.js';

/**
 * Settings for a folder kept in this browser's own storage. They apply to a
 * browser folder only. A folder in the desktop app takes its directory,
 * author, remote, and history policy from the shell that registered it, and
 * reports the policy in effect through `git.snapshot`.
 */
export type BrowserFolderOptions = {
	/**
	 * Captured storage ownership, independent of login changes after opening.
	 * Omitted: retain the established Local database, lock, and hint names.
	 * Release Local also retains those names. Other scopes use separate names
	 * and refuse an empty replacement when an unassigned legacy folder exists.
	 * This option does not migrate data or change private application SQL.
	 */
	readonly scope?: {
		channel: 'release' | 'development';
		account?: AccountIdentity;
	};
	/**
	 * Author and committer of the commits this browser records. Defaults to a
	 * local identity, which is enough for history that stays in the browser. A
	 * folder with a `remote` needs an explicit author.
	 */
	readonly author?: Author;
	/** The remote branch to push to and fetch from. Requires `author`. */
	readonly remote?: GitRemote;
	/**
	 * Whether complete content saves request automatic commits, and pushes
	 * when a remote is configured. Default `true`.
	 */
	readonly commitOnEdit?: boolean;
	/** Injected IndexedDB for tests; defaults to the browser globals. */
	readonly indexedDb?: IndexedDbEnvironment;
};

export type OpenFolderOptions<TDefinition extends DataDefinition> = {
	readonly definition: TDefinition;
	/**
	 * Which folder to open. Defaults to the definition's ID. A browser names
	 * its database after it; the desktop shell maps it to a directory it
	 * registered. It is never a path.
	 */
	readonly id?: string;
	readonly browser?: BrowserFolderOptions;
};

/**
 * The one opener signature. The automatic entry, the browser entry, and the
 * desktop entry each export an `openFolder` of exactly this type.
 */
export type OpenFolder = <const TDefinition extends DataDefinition>(
	options: OpenFolderOptions<TDefinition>,
) => Promise<Result<Folder<TDefinition>, OpenFolderError>>;
