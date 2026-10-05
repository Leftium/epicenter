/**
 * Git operation failures for file folders.
 *
 * These live apart from `history.ts` so a folder whose history runs somewhere
 * else, such as the native folder owner behind Tauri's `invoke`, can build the
 * same errors without loading the Git implementation.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { describe, type FileError, type FileStep } from '../errors.js';
import type { PendingIncoming } from './backend.js';

export const GitError = defineErrors({
	Unconfirmed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `The folder host did not confirm Git ${operation}; the operation may have completed: ${describe(cause)}`,
		operation,
		cause,
	}),
	Failed: ({ operation, cause }: { operation: string; cause: unknown }) => ({
		message: `Git ${operation} failed: ${describe(cause)}`,
		operation,
		cause,
	}),
	Closed: () => ({ message: 'The folder is closed' }),
	NoRemote: () => ({ message: 'No remote is configured for this folder' }),
	StoppedWaiting: ({ operation }: { operation: string }) => ({
		message: `Stopped waiting for Git ${operation}; the shared attempt may still complete`,
		operation,
	}),
	InvalidMessage: ({ reason }: { reason: string }) => ({
		message: `The commit message is not usable: ${reason}`,
		reason,
	}),
	NothingToCommit: () => ({ message: 'Nothing is staged to commit' }),
	/**
	 * A merge in progress still has paths whose index entries are unmerged
	 * stages. Nothing was written; stage each path's resolution, then commit.
	 */
	Unmerged: ({ paths }: { paths: readonly string[] }) => ({
		message: `Committing is not possible because ${paths.length === 1 ? 'a path is' : `${paths.length} paths are`} unmerged: ${paths.join(', ')}; stage the resolved ${paths.length === 1 ? 'file' : 'files'} first`,
		paths,
	}),
	AutomaticHistory: () => ({
		message: 'Staged authoring requires commitOnEdit: false',
	}),
	BranchMoved: ({
		expected,
		actual,
	}: {
		expected: string | undefined;
		actual: string | undefined;
	}) => ({
		message: 'The branch moved while the commit was being written',
		expected,
		actual,
	}),
	/** An incoming update has not finished; staging waits for `recoverIncoming()`. */
	IncomingPending: ({ pending }: { pending: PendingIncoming }) => ({
		message: `${incomingName(pending)} has not finished; recover it before staging or committing`,
		pending,
	}),
});
export type GitError = InferErrors<typeof GitError>;

/** How an error names the incoming update its record describes. */
function incomingName(pending: PendingIncoming): string {
	switch (pending.state) {
		case 'recorded':
			return `Incoming update ${pending.operationId}`;
		case 'unadmitted':
			return 'An incoming update whose admission never finished';
		case 'unreadable':
			return 'An incoming update whose record cannot be read';
	}
}

export const PullError = defineErrors({
	NoFetchedHead: () => ({
		message: 'No fetched remote head is available; fetch first',
	}),
	Blocked: ({ reason }: { reason: string }) => ({
		message: `The folder cannot be updated now: ${reason}`,
		reason,
	}),
	Diverged: ({ head, fetched }: { head: string; fetched: string }) => ({
		message:
			'Local and remote history have diverged; this folder only applies fast-forwards',
		head,
		fetched,
	}),
	Dirty: ({ paths }: { paths: readonly string[] }) => ({
		message: `${paths.length} uncommitted ${paths.length === 1 ? 'change blocks' : 'changes block'} the update`,
		paths,
	}),
	StagedChanges: () => ({
		message: 'Staged changes block the update',
	}),
	Collision: ({ paths }: { paths: readonly string[] }) => ({
		message: `The update would overwrite ${paths.length === 1 ? 'an ignored or untracked file' : `${paths.length} ignored or untracked files`}: ${paths.join(', ')}`,
		paths,
	}),
	Unrepresentable: ({
		paths,
		reason,
	}: {
		paths: readonly string[];
		reason: string;
	}) => ({
		message: `The incoming commit cannot be written to this folder: ${reason}`,
		paths,
		reason,
	}),
	Refused: ({ error }: { error: FileError }) => ({
		message: `A file changed before the update could be written: ${error.message}`,
		error,
	}),
	Partial: ({
		applied,
		error,
	}: {
		applied: readonly FileStep[];
		error: FileError;
	}) => ({
		message: `The update stopped after ${applied.length} file steps; the branch did not move: ${error.message}`,
		applied,
		error,
	}),
	BranchMoved: ({
		actual,
		filesApplied,
	}: {
		actual: string | undefined;
		filesApplied: boolean;
	}) => ({
		message: filesApplied
			? 'Files were updated, but the branch moved before it could be advanced'
			: 'The branch moved before the update could be published; nothing was written',
		actual,
		filesApplied,
	}),
	IndexFailed: ({ error }: { error: string }) => ({
		message: `Files were updated, but the Git index could not be updated; the branch did not move: ${error}`,
		error,
	}),
	/**
	 * A step of the incoming update may or may not have been written: a file,
	 * the index, the branch, or the record itself, named in `uncertain`. Its
	 * record remains, so commits and new updates wait, and only an explicit
	 * `recoverIncoming()` decides from what the folder holds.
	 */
	Unconfirmed: ({
		applied,
		uncertain,
		error,
	}: {
		applied: readonly FileStep[];
		uncertain: readonly string[];
		error: string;
	}) => ({
		message: `The incoming update stopped where ${uncertain.join(', ')} may or may not have been written; it stays pending until it is recovered: ${error}`,
		applied,
		uncertain,
		error,
	}),
	/** An earlier incoming update has not finished. Recover it before another starts. */
	IncomingPending: ({ pending }: { pending: PendingIncoming }) => ({
		message: `${incomingName(pending)} has not finished; recover it before starting another`,
		pending,
	}),
	/**
	 * Recovery found a changed path, the index, the branch, or the record
	 * itself in neither the update's before nor its after state. Nothing was
	 * written; the update stays pending. Once each named path holds one of its
	 * states, recover again.
	 */
	RecoveryRefused: ({
		pending,
		paths,
		reason,
	}: {
		pending: PendingIncoming;
		paths: readonly string[];
		reason: string;
	}) => ({
		message: `${incomingName(pending)} cannot be recovered: ${reason}`,
		pending,
		paths,
		reason,
	}),
});
export type PullError = InferErrors<typeof PullError>;

/**
 * One reason a merge could not combine both sides by itself. `ours` is the
 * local branch and `theirs` the fetched remote head, as in Git.
 */
export type MergeConflict =
	/** Both sides changed the same lines of a text file. */
	| { readonly reason: 'content'; readonly path: string }
	/**
	 * Both sides changed a file whose bytes are not merged as text here: not
	 * UTF-8, holding a NUL byte, or holding line breaks the line merge would
	 * not keep (a lone carriage return, U+2028, or U+2029).
	 */
	| { readonly reason: 'binary'; readonly path: string }
	/** One side deleted a file the other side changed. */
	| {
			readonly reason: 'deleted';
			readonly path: string;
			readonly deletedBy: 'ours' | 'theirs';
	  }
	/** One side has a file where the other has a directory. */
	| { readonly reason: 'shape'; readonly path: string }
	/** Both sides changed one root key of `kv.json` to different values. Values are raw JSON text, `null` for an absent key. */
	| {
			readonly reason: 'kvKey';
			readonly path: string;
			readonly key: string;
			readonly base: string | null;
			readonly ours: string | null;
			readonly theirs: string | null;
	  }
	/** One side deleted `kv.json` while the other changed its values. */
	| { readonly reason: 'kvFile'; readonly path: string }
	/** Both sides changed `kv.json`, and `side`'s text is not a KV object `mergeKv` accepts. */
	| {
			readonly reason: 'kvInvalid';
			readonly path: string;
			readonly side: 'base' | 'ours' | 'theirs';
	  };

export const MergeError = defineErrors({
	Unsupported: ({ reason }: { reason: string }) => ({
		message: `This folder cannot merge incoming changes: ${reason}`,
		reason,
	}),
	/** The two heads have no common commit, or more than one best one. */
	UnsupportedHistory: ({
		head,
		fetched,
		bases,
	}: {
		head: string;
		fetched: string;
		bases: number;
	}) => ({
		message:
			bases === 0
				? 'Local and remote history share no commit, so they cannot be merged'
				: `Local and remote history have ${bases} merge bases; only a single merge base is supported`,
		head,
		fetched,
		bases,
	}),
	/** A path would need a merge this folder does not perform faithfully. Nothing was written. */
	Unmergeable: ({
		paths,
		reason,
	}: {
		paths: readonly string[];
		reason: string;
	}) => ({
		message: `The histories cannot be merged here: ${reason}`,
		paths,
		reason,
	}),
	/**
	 * Competing changes need a person. Nothing was written to files, the
	 * index, or the branch. A merge asked to leave its conflicts gets this
	 * only for conflicts it cannot leave as files: a file against a directory.
	 */
	Conflicted: ({ conflicts }: { conflicts: readonly MergeConflict[] }) => ({
		message: `${conflicts.length} ${conflicts.length === 1 ? 'conflict blocks' : 'conflicts block'} the merge: ${[
			...new Set(conflicts.map((conflict) => conflict.path)),
		].join(', ')}`,
		conflicts,
	}),
});
export type MergeError = InferErrors<typeof MergeError>;
