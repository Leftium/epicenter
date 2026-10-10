/**
 * Content-save accounting, the close fence over acquired storage, and the
 * one-change publication every ordinary domain method makes.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileChange, FolderStorage } from './boundary.js';
import { type FileCapture, fileCapture, hashBytes } from './capture.js';
import { FileError, type FileStep, MoveError } from './errors.js';
import type { History } from './git/history.js';

const stepPaths = (step: FileStep | FileChange): string[] =>
	step.kind === 'move' ? [step.from, step.to] : [step.path];

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
		async apply(changes) {
			const result = await storage.apply(changes);
			const { error: applyError } = result;
			if (applyError === null && changes.length > 0) {
				history.noteEdit();
				history.requestAutomaticCommit();
				landed(changes.flatMap(stepPaths));
			} else if (applyError?.name === 'Partial') {
				history.noteEdit();
				// An uncertain failed step may have landed too. A hint asks for a
				// reread; it does not confirm publication or request a commit.
				landed([
					...applyError.applied.flatMap(stepPaths),
					...(applyError.error.name === 'Unconfirmed'
						? stepPaths(applyError.failed)
						: []),
				]);
			} else if (applyError?.name === 'Unconfirmed') {
				// The paths may have changed. Say so, but request no commit for an
				// outcome nobody knows.
				history.noteEdit();
				landed(changes.flatMap(stepPaths));
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
		apply: (changes) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.apply(changes),
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
 * `MoveError.SourceNotRemoved`, which names the destination with the move's
 * guard hash, a baseline-conditioned receipt rather than a read of what the
 * destination holds now. Any other partial report contradicts a single
 * change, so its outcome is `Unconfirmed` and carries the report as its
 * cause. Accounting below this call has already seen the raw report and
 * announced the landed paths.
 */
export function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: Exclude<FileChange, Move>,
): Promise<Result<undefined, FileError>>;
export function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: Move & { expectedSha256: string },
): Promise<Result<undefined, FileError | MoveError>>;
export async function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: Exclude<FileChange, Move> | (Move & { expectedSha256: string }),
): Promise<Result<undefined, FileError | MoveError>> {
	const { error } = await storage.apply([change]);
	if (error === null) return Ok(undefined);
	if (error.name !== 'Partial') return Err(error);
	const [landed, ...rest] = error.applied;
	if (
		change.kind === 'move' &&
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

/**
 * Replace the captured file's bytes and return the capture of the new ones.
 * Refused as `Conflict` when the file no longer holds the captured bytes. A
 * reply that leaves the outcome `Unconfirmed` is checked with one read:
 * bytes that hash to what was sent are this save, confirmed after all, so a
 * session does not mistake its own landed save for someone else's change.
 */
export async function replaceCaptured(
	storage: Pick<FolderStorage, 'apply' | 'read'>,
	file: FileCapture,
	bytes: Uint8Array,
): Promise<Result<FileCapture, FileError>> {
	const sha256 = await hashBytes(bytes);
	const applied = await applyOne(storage, {
		kind: 'replace',
		path: file.path,
		bytes,
		sha256,
		expectedSha256: file.sha256,
	});
	if (applied.error === null) return Ok(fileCapture(file.path, sha256));
	if (applied.error.name !== 'Unconfirmed') return Err(applied.error);
	const read = await storage.read(file.path);
	if (read.error === null && read.data.sha256 === sha256)
		return Ok(fileCapture(file.path, sha256));
	return Err(applied.error);
}
