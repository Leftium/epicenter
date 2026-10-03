/**
 * What the shared history coordinator needs from a folder's Git storage.
 *
 * The browser backend keeps objects, refs, and the index in IndexedDB and
 * uses isomorphic-git. The native backend writes objects with
 * isomorphic-git but leaves index and ref mutation to the real `git` CLI,
 * whose lock files other native Git processes respect.
 *
 * Backend methods throw on failure; the coordinator turns failures into
 * reported outcomes.
 */
import type { FileChange } from '../boundary.js';
import type { FileError, FileStep } from '../errors.js';
import type { DeclaredAttribute } from './attributes.js';
import type { CapturedIndex } from './captured-index.js';
import type {
	Author,
	CommitSummary,
	ObjectAccess,
	TreeFile,
} from './objects.js';

export type StatusCode = ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

/** One path's staged (`index`) and unstaged (`worktree`) state, as `git status` reports it. */
export type PathStatus = {
	readonly path: string;
	readonly index: StatusCode;
	readonly worktree: StatusCode;
};

export type GitRemote = {
	readonly url: string;
	readonly branch: string;
};

export type CasResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly actual: string | undefined };

/**
 * An incoming fast-forward or merge, prepared against observed files and
 * refs. `nextHead` is the fetched commit or the merge commit; `changes` turn
 * the files of `expectedHead` into its tree.
 */
export type IncomingPlan = {
	readonly expectedHead: string | undefined;
	readonly nextHead: string;
	readonly changes: readonly FileChange[];
	readonly paths: readonly string[];
	/**
	 * What the folder held when the update was planned: the SHA-256 of every
	 * portable file, and the exact index bytes checked for cleanliness. The browser
	 * requires both unchanged inside its publication transaction. A folder on
	 * disk checks only each changed file's own condition, best effort.
	 */
	readonly baseline: {
		readonly files: ReadonlyMap<string, string>;
		readonly index: Uint8Array | undefined;
	};
};

export type PublishResult =
	| { readonly status: 'published' }
	/** Nothing was written. */
	| { readonly status: 'refused'; readonly error: FileError }
	/** Browser only: the index changed after it was observed. Nothing was written. */
	| { readonly status: 'indexChanged' }
	/** Nothing was written (browser); or files and index were applied first (native). */
	| {
			readonly status: 'branchMoved';
			readonly actual: string | undefined;
			readonly filesApplied: boolean;
	  }
	/** Native only: some file steps reached the folder; the branch did not move. */
	| {
			readonly status: 'partial';
			readonly applied: readonly FileStep[];
			readonly error: FileError;
	  }
	/** Native only: files were applied; updating the index failed; the branch did not move. */
	| { readonly status: 'indexFailed'; readonly error: string };

/** Whether `tryExclusive` ran its work, and what the work returned. */
export type Admitted<T> =
	| { readonly ran: true; readonly value: T }
	| { readonly ran: false };

export type GitBackend = {
	readonly branch: string;
	readonly remote: GitRemote | undefined;
	/** Run object work. The browser flushes new objects durably before returning. */
	withObjects<T>(work: (access: ObjectAccess) => Promise<T>): Promise<T>;
	/**
	 * Serialize this folder's index and branch work. Network work never runs
	 * inside. A `signal` that aborts while `work` is still waiting rejects with
	 * the signal's reason and `work` never runs; once `work` has started, the
	 * signal changes nothing.
	 */
	exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
	/**
	 * `exclusive` without the wait: run `work` only if nothing holds or waits
	 * for that same protection right now, in this process or, in a browser,
	 * in another tab. Otherwise `work` never runs, now or later. A browser
	 * without Web Locks cannot ask other tabs and always refuses.
	 */
	tryExclusive<T>(work: () => Promise<T>): Promise<Admitted<T>>;
	readBranch(): Promise<string | undefined>;
	readRemoteTracking(): Promise<string | undefined>;
	/** Move the branch only if it still names `expected`. */
	casBranch(expected: string | undefined, next: string): Promise<CasResult>;
	/** Why automatic commits must not run now, such as a native merge in progress. */
	blocked(): Promise<string | undefined>;
	/**
	 * Why a whole-folder commit or fast-forward cannot represent this
	 * repository faithfully: every file is written as plain `100644` bytes
	 * with no attribute filters, so symbolic links, executables, submodules,
	 * nested Git data, and normalizing attributes are refused rather than
	 * silently rewritten. Explicit staging and staged commits are unaffected.
	 */
	checkpointProblem(): Promise<string | undefined>;
	/**
	 * The first of `files` that `commit`'s own attribute files give a filter
	 * or a byte conversion, or `undefined` when every one is plain bytes.
	 * `files` is the commit's whole tree, so an attribute that selects a file
	 * the commit did not change is found too. Only the pinned commit decides:
	 * attributes of the files currently in the folder are not consulted.
	 */
	incomingAttribute(
		commit: string,
		files: ReadonlyMap<string, TreeFile>,
	): Promise<DeclaredAttribute | undefined>;
	/**
	 * Make every index entry match `commit`'s tree, including staged-only
	 * additions and deletions. Returns the paths it reset.
	 */
	reconcileIndex(commit: string): Promise<string[]>;
	/** Which untracked candidates `.gitignore` (and native excludes) ignore. */
	ignoredPaths(
		candidates: readonly string[],
		current: ReadonlyMap<string, Uint8Array>,
	): Promise<ReadonlySet<string>>;
	/** When supplied, checks these exact captured bytes against this pinned head. */
	indexMatchesHead(captured?: CapturedIndex): Promise<boolean>;
	/** The index file's stored bytes, or `undefined` when there is none. */
	readIndex(): Promise<Uint8Array | undefined>;
	/**
	 * Why this folder does not merge diverged histories, or `undefined` when it
	 * does. Only the browser merges; it publishes the result in one transaction.
	 */
	readonly mergeUnsupported: string | undefined;
	pathStatus(): Promise<PathStatus[]>;
	/** Stage current contents of `paths`, including deletions; `'all'` stages everything. */
	stage(paths: readonly string[] | 'all'): Promise<void>;
	/** Commit the index onto the pinned branch head. */
	commitIndex(
		message: string,
		author: Author,
	): Promise<
		| {
				readonly status: 'committed';
				readonly oid: string;
				readonly parent: string | undefined;
		  }
		| { readonly status: 'nothing' }
		| { readonly status: 'branchMoved'; readonly actual: string | undefined }
	>;
	diff(options: { staged: boolean; paths: readonly string[] }): Promise<string>;
	log(depth: number): Promise<CommitSummary[]>;
	/** Push an exact commit to the configured remote branch. */
	push(oid: string, signal: AbortSignal): Promise<void>;
	/** Fetch the configured remote branch; returns its commit, or undefined if absent. */
	fetch(signal: AbortSignal): Promise<string | undefined>;
	/** Publish files, index, and branch for an incoming fast-forward or merge. */
	publishIncoming(plan: IncomingPlan): Promise<PublishResult>;
};
