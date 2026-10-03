/**
 * The page's order of saves, content-save accounting, the close fence over
 * acquired storage, and the one-change publication every ordinary domain
 * method makes.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileChange, FolderStorage, Submission } from './boundary.js';
import { fileCapture } from './capture.js';
import { FileError, type FileStep, MoveError } from './errors.js';
import type { History } from './git/history.js';

const stepPaths = (step: FileStep | FileChange): string[] =>
	step.kind === 'move' ? [step.from, step.to] : [step.path];

let reserved = 0;

/**
 * Take the next place in this page's order of saves. Every public method
 * that saves calls this synchronously when it is entered, before it hashes,
 * reads, or delivers to a listener, so its place is the order the page asked
 * in, whichever save finishes preparing first. One sequence serves every
 * folder handle and root of the page; it only grows, and a place whose save
 * was never sent leaves a gap. A place authorizes nothing: a save is still
 * fenced when the folder closes.
 */
export function reserveSubmission(): Submission {
	reserved += 1;
	return reserved as Submission;
}

/** Browser and Bun record local saves here; the desktop owner records its own. */
export function withPublication({
	storage,
	history,
	landed,
}: {
	storage: FolderStorage;
	history: Pick<History, 'noteEdit' | 'requestAutomaticCommit'>;
	landed: (paths: readonly string[]) => void;
}): FolderStorage {
	return {
		...storage,
		async apply(changes, submission) {
			const result = await storage.apply(changes, submission);
			if (result.error === null && changes.length > 0) {
				history.noteEdit();
				history.requestAutomaticCommit();
				landed(changes.flatMap(stepPaths));
			} else if (result.error?.name === 'Partial') {
				history.noteEdit();
				landed(result.error.applied.flatMap(stepPaths));
			}
			return result;
		},
	};
}

/** Fence the next backend call. A begun call owns its complete result. */
export function fenceStorage(
	storage: FolderStorage,
	signal: AbortSignal,
): FolderStorage {
	return {
		list: () =>
			signal.aborted ? Promise.resolve(FileError.Closed()) : storage.list(),
		children: (directory) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.children(directory),
		read: (path) =>
			signal.aborted ? Promise.resolve(FileError.Closed()) : storage.read(path),
		readMany: (paths) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.readMany(paths),
		open: (path) =>
			signal.aborted ? Promise.resolve(FileError.Closed()) : storage.open(path),
		apply: (changes, submission) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.apply(changes, submission),
		mkdir: (path) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.mkdir(path),
		rmdir: (path) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.rmdir(path),
	};
}

type Move = Extract<FileChange, { kind: 'move' }>;

/**
 * Publish one change and state its outcome as one file operation.
 *
 * Raw storage reports a move whose destination landed but whose source was
 * not removed as a partial application; that becomes
 * `MoveError.SourceNotRemoved`, with the capture of the bytes now at the
 * destination. Any other partial report contradicts a single change, so its
 * outcome is `Unconfirmed` and carries the report as its cause. Accounting
 * below this call has already seen the raw report and announced the landed
 * paths. `submission` is the place the caller reserved when it was entered.
 */
export function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: Exclude<FileChange, Move>,
	submission: Submission,
): Promise<Result<undefined, FileError>>;
export function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: Move & { expectedSha256: string },
	submission: Submission,
): Promise<Result<undefined, FileError | MoveError>>;
export async function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: FileChange,
	submission: Submission,
): Promise<Result<undefined, FileError | MoveError>> {
	const { error } = await storage.apply([change], submission);
	if (error === null) return Ok(undefined);
	if (error.name !== 'Partial') return Err(error);
	const [landed, ...rest] = error.applied;
	if (
		change.kind === 'move' &&
		change.expectedSha256 !== undefined &&
		rest.length === 0 &&
		landed?.kind === 'write' &&
		landed.path === change.to
	)
		return MoveError.SourceNotRemoved({
			from: change.from,
			to: change.to,
			moved: fileCapture(change.to, change.expectedSha256),
			cause: error.error,
		});
	return FileError.Unconfirmed({
		path: change.kind === 'move' ? change.from : change.path,
		operation: 'publishing',
		cause: error,
	});
}
