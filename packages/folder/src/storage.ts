/** Content-save accounting and the close fence over acquired storage. */
import type { FileChange, FolderStorage } from './boundary.js';
import { FileError, type FileStep } from './errors.js';
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
