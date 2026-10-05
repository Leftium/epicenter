/**
 * What the shared history coordinator needs from a folder's Git storage.
 *
 * The browser backend keeps objects, refs, and the index in the folder's
 * private `.git` in the origin private file system and uses isomorphic-git. The native backend writes objects with
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
 * A path a merge left for a person, with the blob each side had there:
 * Git's index stages 1 (`base`), 2 (`ours`), and 3 (`theirs`). A side
 * without the file has no stage. Every stage is a plain `100644` file.
 */
export type UnmergedPath = {
	readonly path: string;
	readonly base: string | undefined;
	readonly ours: string | undefined;
	readonly theirs: string | undefined;
};

/**
 * Where an incoming merge with conflicts left in place ends. The branch
 * stays at `expectedHead`; the files and the index take the tree of the
 * plan's `nextHead`, a commit no ref ever names, except that each unmerged
 * path's index entry is its stages; and Git's merge state records
 * `MERGE_HEAD` (`incoming`), `MERGE_MSG` (`message`), and `ORIG_HEAD`
 * (`expectedHead`).
 */
export type UnfinishedMerge = {
	readonly incoming: string;
	readonly message: string;
	readonly unmerged: readonly UnmergedPath[];
};

/**
 * Git's merge state as the repository holds it: a merge that began and has
 * not been committed.
 */
export type MergeInProgress = {
	/** `MERGE_HEAD`: the pinned incoming commit, the merge commit's second parent. */
	readonly incoming: string;
	/** `ORIG_HEAD`: the branch head the merge began from, when recorded. */
	readonly head: string | undefined;
	/**
	 * Paths whose index entry is still unmerged stages, in index order. Empty
	 * once every one is staged, while the merge waits for its commit.
	 */
	readonly unresolved: readonly string[];
};

/**
 * An incoming fast-forward or merge, prepared against observed files and
 * refs. `nextHead` is the fetched commit or the merge commit; `changes` turn
 * the files of `expectedHead` into its tree.
 */
export type IncomingPlan = {
	readonly expectedHead: string | undefined;
	readonly nextHead: string;
	/**
	 * Present for a merge whose conflicts are left in place: `nextHead` is
	 * then the unreachable commit of the files with markers, and the branch
	 * does not move.
	 */
	readonly merge?: UnfinishedMerge;
	readonly changes: readonly FileChange[];
	readonly paths: readonly string[];
	/**
	 * What the folder held when the update was planned: the SHA-256 of every
	 * portable file, and the exact index bytes checked for cleanliness. The browser
	 * requires both unchanged under its publication locks before it writes. A
	 * folder on disk checks only each changed file's own condition, best effort.
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
	/** Nothing was written, or files and index were applied first: `filesApplied` says which. */
	| {
			readonly status: 'branchMoved';
			readonly actual: string | undefined;
			readonly filesApplied: boolean;
	  }
	/**
	 * The update stopped after some of it landed, and the step that failed
	 * certainly wrote nothing; the branch did not move. `applied` names the
	 * file steps that reached the folder. It may be empty when only Git state
	 * landed: a Bun directory's unfinished merge prepares its index and merge
	 * state before any file, and keeps them. A browser keeps its incoming
	 * record until `recoverIncoming` is asked for.
	 */
	| {
			readonly status: 'partial';
			readonly applied: readonly FileStep[];
			readonly error: FileError;
	  }
	/** Files were applied; the index was not written; the branch did not move. */
	| { readonly status: 'indexFailed'; readonly error: string }
	/**
	 * A step's outcome is unknown: `uncertain` names the file, the index, or
	 * the branch that may or may not have been written. The browser's record
	 * remains, and only an explicit recovery decides what happened.
	 */
	| {
			readonly status: 'unconfirmed';
			readonly applied: readonly FileStep[];
			readonly uncertain: readonly string[];
			readonly error: string;
	  };

/**
 * An incoming update whose authored changes may have begun. Everything else
 * (changed paths, target bytes, target index) is derived from the trees of
 * `expectedHead` and `nextHead`.
 */
export type RecordedIncoming = {
	readonly state: 'recorded';
	readonly operationId: string;
	readonly branch: string;
	/** The branch head the update was admitted over; `undefined` for an empty history. */
	readonly expectedHead: string | undefined;
	/**
	 * The fetched commit, or the prepared merge commit. For a merge whose
	 * conflicts are left in place, the commit of the files with markers,
	 * which the branch never names.
	 */
	readonly nextHead: string;
	/**
	 * Present when the update ends in an unfinished merge rather than a moved
	 * branch. Recovery then publishes the files, the index with its stages,
	 * and the merge state; it never resolves a path or clears a stage.
	 */
	readonly merge?: UnfinishedMerge;
};

/**
 * What a browser folder's incoming record says. While there is one, staging,
 * commits, and new incoming updates wait for an explicit recovery.
 */
export type PendingIncoming =
	| RecordedIncoming
	/**
	 * The record file exists and is empty: its write never finished, so the
	 * update was never admitted and changed no authored file.
	 */
	| { readonly state: 'unadmitted' }
	/** The record holds bytes that are not a record. Nothing reads past it or removes it. */
	| { readonly state: 'unreadable'; readonly reason: string };

/** What an explicit recovery of a pending incoming update did. */
export type RecoverIncomingResult =
	| { readonly status: 'none' }
	/** An `unadmitted` record was removed; no authored file was written. */
	| { readonly status: 'admissionCleared' }
	/** The branch already named `nextHead`: the record was cleared and no file was written. */
	| { readonly status: 'cleared'; readonly pending: RecordedIncoming }
	/** Paths at their before state were written; the index and branch followed. */
	| {
			readonly status: 'completed';
			readonly pending: RecordedIncoming;
			readonly changedPaths: readonly string[];
	  }
	/** A path, the index, the branch, or the record is in neither state. Nothing was written. */
	| {
			readonly status: 'refused';
			readonly pending: PendingIncoming;
			readonly paths: readonly string[];
			readonly reason: string;
	  }
	/** Recovery stopped partway; the record remains. */
	| {
			readonly status: 'partial';
			readonly pending: RecordedIncoming;
			readonly applied: readonly FileStep[];
			readonly error: FileError;
	  }
	/** A step's outcome is unknown; the record remains. */
	| {
			readonly status: 'unconfirmed';
			readonly pending: RecordedIncoming;
			readonly applied: readonly FileStep[];
			readonly uncertain: readonly string[];
			readonly error: string;
	  };

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
	readBranch(): Promise<string | undefined>;
	readRemoteTracking(): Promise<string | undefined>;
	/** Move the branch only if it still names `expected`. */
	casBranch(expected: string | undefined, next: string): Promise<CasResult>;
	/**
	 * Why no commit may run now, such as a detached `HEAD` or a rebase in
	 * progress. A merge in progress is not reported here: it blocks
	 * whole-folder work but is what a staged commit finishes (`mergeState`).
	 */
	blocked(): Promise<string | undefined>;
	/**
	 * The merge Git records as begun and not committed, or `undefined`.
	 * Throws when `MERGE_HEAD` exists but names no commit.
	 */
	mergeState(): Promise<MergeInProgress | undefined>;
	/**
	 * Remove `MERGE_HEAD` and `MERGE_MSG`, once the merge commit they describe
	 * is on the branch. `ORIG_HEAD` stays, as Git leaves it.
	 */
	clearMerge(): Promise<void>;
	/**
	 * Why a whole-folder commit or fast-forward cannot represent this
	 * repository faithfully: every file is written as plain `100644` bytes
	 * with no attribute filters, so symbolic links, executables, submodules,
	 * nested Git data, and normalizing attributes are refused rather than
	 * silently rewritten. Unmerged index stages with no `MERGE_HEAD` are
	 * refused too: a checkpoint would reset them and record conflict markers
	 * as ordinary content. Explicit staging and staged commits are unaffected.
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
	/** Check these exact captured bytes against this pinned head. */
	indexMatchesHead(captured: CapturedIndex): Promise<boolean>;
	/** The index file's stored bytes, or `undefined` when there is none. */
	readIndex(): Promise<Uint8Array | undefined>;
	pathStatus(): Promise<PathStatus[]>;
	/**
	 * Stage current contents of `paths`, including deletions; `'all'` stages
	 * everything. An unmerged path always loses its stages, even when its
	 * bytes equal one of them.
	 */
	stage(paths: readonly string[] | 'all'): Promise<void>;
	/**
	 * Commit the index's tree onto a parent pinned before anything is
	 * written: the branch head when the commit starts, or, with `merge`,
	 * `merge.head`, the head the merge began from, whatever the branch names
	 * now. A merge's second parent is `merge.incoming`, and its commit is
	 * written even when its tree equals the head's; without `merge`, a tree
	 * equal to the parent's is `nothing`. The branch moves only if it still
	 * names the pinned parent; otherwise the result is `branchMoved` and no
	 * ref, index entry, or merge state changes.
	 */
	commitIndex(
		message: string,
		author: Author,
		merge?: { readonly head: string; readonly incoming: string },
	): Promise<
		| {
				readonly status: 'committed';
				readonly oid: string;
				readonly parent: string | undefined;
		  }
		| { readonly status: 'nothing' }
		| {
				readonly status: 'branchMoved';
				readonly expected: string | undefined;
				readonly actual: string | undefined;
		  }
	>;
	diff(options: { staged: boolean; paths: readonly string[] }): Promise<string>;
	log(depth: number): Promise<CommitSummary[]>;
	/** Push an exact commit to the configured remote branch. */
	push(oid: string, signal: AbortSignal): Promise<void>;
	/** Fetch the configured remote branch; returns its commit, or undefined if absent. */
	fetch(signal: AbortSignal): Promise<string | undefined>;
	/**
	 * Publish files, index, and branch for an incoming fast-forward or merge;
	 * for a plan with `merge`, files, the index with its stages, and the merge
	 * state, leaving the branch.
	 */
	publishIncoming(plan: IncomingPlan): Promise<PublishResult>;
	/**
	 * Whether incoming publication removes the directories its removals
	 * emptied, so a file may take the place of a directory whose files the
	 * same update removes, and the reverse. A backend that omits this refuses
	 * such an update as a collision.
	 */
	readonly replacesDirectories?: boolean;
	/**
	 * The recorded incoming update that has not finished. Only a backend that
	 * publishes incoming updates in steps keeps one; the others omit this.
	 */
	pendingIncoming?(): Promise<PendingIncoming | undefined>;
	/**
	 * Finish or clear the pending incoming update. Runs only when asked, inside
	 * `exclusive`; nothing resumes an update implicitly.
	 */
	recoverIncoming?(): Promise<RecoverIncomingResult>;
};
