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
import type { AccountIdentity } from '@epicenter/principal';
import type { Result } from 'wellcrafted/result';
import type { FolderDefinition } from './definition.js';
import type { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import type { GitRemote } from './git/backend.js';
import type { HttpFetch } from './git/http.js';
import type { Author } from './git/objects.js';
import type { OpfsEnvironment } from './opfs-store.js';

export {
	type CreateRowOf,
	defineTable,
	field,
	type KvOf,
} from '@epicenter/definition';
export type { FileListing } from './boundary.js';
export {
	type CanonicalDocument,
	type CanonicalRefusal,
	type CanonicalValue,
	formatCanonicalDocument,
	parseCanonicalDocument,
} from './canonical.js';
export {
	type CapturedFile,
	type FileCapture,
	hashBytes,
	submittedText,
	type TextCapture,
} from './capture.js';
export {
	defineFolder,
	type FolderDefinition,
	type FolderTable,
	type PreparedFolderTable,
} from './definition.js';
export {
	type RowEditor,
	RowEditorError,
	type RowEditorState,
	type RowError,
	type RowReloadError,
	type RowSaveError,
	type RowSetError,
	type RowState,
	type SaveState,
	type TableEditError,
} from './editor.js';
export {
	type CapturedMoveError,
	FileError,
	type FileStep,
	type KvReadError,
	type KvWriteError,
	MoveError,
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
export type {
	GitRemote,
	MergeInProgress,
	PathStatus,
	PendingIncoming,
	RecordedIncoming,
	StatusCode,
	UnfinishedMerge,
	UnmergedPath,
} from './git/backend.js';
export {
	type ConflictVersion,
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
	MergeConflictPolicy,
	MergeOutcome,
	Observation,
	PullOutcome,
	PushOutcome,
	RecoverOutcome,
	StagedCommit,
	SyncObservation,
} from './git/history.js';
export type { HttpFetch } from './git/http.js';
export { commitSubject, escapePath, type PathChange } from './git/messages.js';
export type { Author, CommitSummary } from './git/objects.js';
export type { FileKv, KvReading, KvSnapshot } from './kv.js';
export { type KvMerge, type KvMergeInput, mergeKv } from './kv-merge.js';
export {
	frameRowText,
	type PatchRefusal,
	patchRowText,
	type RowTextChange,
	type RowTextFrame,
} from './markdown.js';
export type {
	OpfsDirectoryHandle,
	OpfsEnvironment,
	OpfsFileHandle,
	OpfsLocks,
} from './opfs-store.js';
export { pathProblem, rowPath, rowStemOf } from './paths.js';
export type { DeepReadonly, FieldIssue, ParseError } from './reading.js';
export {
	inspectRow,
	type RowDraft,
	serializeRow,
	type TableReading,
} from './row-text.js';
export type {
	FileTable,
	TableListing,
	TableSnapshot,
	TableWriteOptions,
	TableWriteReceipt,
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
	 * Omitted: release Local. Each channel, owner, and folder ID is its own
	 * origin private file system directory, Web Locks, and hint channel. A
	 * scoped folder never reads the Local folder of the same ID. This option
	 * does not change private application SQL.
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
	 * Fetch-compatible HTTP transport used for Git fetch and push. An application
	 * can route the canonical remote through its authenticated relay without
	 * replacing the page's fetch. Defaults to global fetch and receives the
	 * operation's abort signal. Authentication belongs to the supplied transport,
	 * not to the folder or remote configuration.
	 */
	readonly httpFetch?: HttpFetch;
	/**
	 * Whether complete content saves request automatic local commits.
	 * Transfers remain explicit. Default `true`.
	 */
	readonly commitOnEdit?: boolean;
	/**
	 * Whether opening makes a folder where none exists. Default `true`. With
	 * `false`, a missing or empty directory is `Absent`, decided under the
	 * same open lock that would create it, and nothing is created: no
	 * directory, marker, private Git state, or `definition.json`. A folder
	 * already there opens either way. An account app can then offer an
	 * explicit download or start instead of creating one at startup.
	 */
	readonly createIfMissing?: boolean;
	/**
	 * Injected origin private file system, Web Locks, and hint channel; for
	 * tests. Defaults to the browser globals.
	 */
	readonly opfs?: OpfsEnvironment;
};

export type OpenFolderOptions<TDefinition extends FolderDefinition> = {
	/** How this caller reads the folder's files. It names no folder. */
	readonly definition: TDefinition;
	/**
	 * Which folder to open: its dataset name relative to the owner, such as
	 * `so.epicenter.todos`. Required, and never a path. A browser names its
	 * directory after it; the desktop shell maps it to a directory it
	 * registered.
	 */
	readonly id: string;
	readonly browser?: BrowserFolderOptions;
};

/**
 * The one opener signature. The automatic entry, the browser entry, and the
 * desktop entry each export an `openFolder` of exactly this type.
 */
export type OpenFolder = <const TDefinition extends FolderDefinition>(
	options: OpenFolderOptions<TDefinition>,
) => Promise<Result<Folder<TDefinition>, OpenFolderError>>;
