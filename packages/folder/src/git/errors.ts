/**
 * Git operation failures for file folders.
 *
 * These live apart from `history.ts` so a folder whose history runs somewhere
 * else, such as the native folder owner behind Tauri's `invoke`, can build the
 * same errors without loading the Git implementation.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { describe, type FileError, type FileStep } from '../errors.js';

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
});
export type GitError = InferErrors<typeof GitError>;

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
});
export type PullError = InferErrors<typeof PullError>;
