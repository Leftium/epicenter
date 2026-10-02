/**
 * The opened folder handle every opener returns (ADR-0471, ADR-0478).
 *
 * `tables`, `kv`, `files`, and `batch` publish through one file boundary.
 * `git` observes and records history. A complete content save makes one
 * automatic commit attempt when the folder's history policy says so.
 *
 * Closing fences new file work and history requests and stops network work
 * at once. Saves that were already admitted then finish, without starting a
 * commit. History work that was already running finishes, and storage is
 * released last. Closing makes no last commit.
 */
import type {
	CreateRowOf,
	DataDefinition,
	KvOf,
	ParsedDataDefinition,
} from '@epicenter/definition';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type BatchReceipt,
	type BatchChange,
	checkRowDestinations,
	collectBatch,
	type FolderBatch,
	receiptOf,
	toChange,
} from './batch.js';
import type {
	FileBoundary,
	FileChange,
	FileWriteIntent,
	FileListing,
	FileRead,
} from './boundary.js';
import {
	type ApplyError,
	type BatchError,
	FileError,
	type FileStep,
	type TableWriteError,
} from './errors.js';
import type { GitRemote, PathStatus } from './git/backend.js';
import type {
	CommitAndPushResult,
	CommitOutcome,
	FetchOutcome,
	FilesObservation,
	GitError,
	GitSnapshot,
	History,
	PullError,
	PullOutcome,
	PushOutcome,
} from './git/history.js';
import type { Author, CommitSummary } from './git/objects.js';
import { createFileKv, type FileKv } from './kv.js';
import { callObserver } from './observer.js';
import { createFileTable, type FileTable } from './table.js';
import type { FolderTerminal, TerminalResult } from './terminal.js';
import {
	type CapturedFile,
	captureProblem,
	hashBytes,
	type FileCapture,
	fileCapture,
	ownBytes,
} from './capture.js';

/** History settings for a folder whose history this process records. */
export type FolderGitOptions = {
	/** Author and committer for automatic and staged commits. */
	readonly author: Author;
	/** The remote branch to push to and fetch from. */
	readonly remote?: GitRemote;
	/**
	 * Whether complete content saves request automatic commits and pushes when
	 * a remote is configured. Fixed for this handle's lifetime. Default `true`.
	 */
	readonly commitOnEdit?: boolean;
};

/**
 * Ordinary files at literal folder-relative paths (ADR-0479).
 *
 * The verb states the condition a save publishes under. Strings are saved as
 * UTF-8 with nothing added or normalized; byte arrays are copied when the
 * method is called and saved exactly. A successful save returns a new
 * capture of the bytes it was given: nothing is read back, and the capture
 * that was passed in never changes.
 */
export type FolderFiles = {
	list(): Promise<Result<FileListing, FileError>>;
	children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>>;
	/** The file's bytes, detached from storage, with the capture that identifies them. */
	read(path: string): Promise<Result<CapturedFile, FileError>>;
	/** Stable bytes for consumption (ADR-0466). */
	open(path: string): Promise<Result<Blob, FileError>>;
	/** Save a new file. Refused when anything is already at the path. */
	create(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError | ApplyError>>;
	/** Save over the captured file. Refused when its bytes are no longer the captured ones. */
	replace(
		file: FileCapture,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError | ApplyError>>;
	/** Remove the captured file. Refused when its bytes are no longer the captured ones. */
	remove(file: FileCapture): Promise<Result<undefined, FileError | ApplyError>>;
	/**
	 * Move the captured file to an unoccupied path. The returned capture is the
	 * same content hash at the destination.
	 */
	move(
		file: FileCapture,
		destination: string,
	): Promise<Result<FileCapture, FileError | ApplyError>>;
	/** Save at the path whatever is there, as a shell redirection does. */
	overwrite(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError | ApplyError>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

export type FolderGit = {
	readonly snapshot: GitSnapshot;
	/** Delivers the current snapshot synchronously, then each change. */
	subscribe(listener: (snapshot: GitSnapshot) => void): () => void;
	/** A fresh inspection of uncommitted changes and local/remote heads. */
	status(): Promise<Result<FilesObservation, GitError>>;
	/**
	 * Commit current source files if they changed, and reset the index to the
	 * head either way. Never pushes.
	 */
	commit(): Promise<CommitOutcome>;
	/**
	 * Commit, then push. `signal` only stops this caller waiting
	 * (`stoppedWaiting`): a commit or transport that already started keeps
	 * running, and closing the folder is what aborts owned network work. In a
	 * browser or directory folder, a push or fetch that had not started when
	 * its caller left is never started. The same holds for `push` and `fetch`.
	 */
	commitAndPush(options?: {
		signal?: AbortSignal;
	}): Promise<CommitAndPushResult>;
	push(options?: { signal?: AbortSignal }): Promise<PushOutcome>;
	fetch(options?: {
		signal?: AbortSignal;
	}): Promise<Result<FetchOutcome, GitError>>;
	/** Apply the fetched remote head only as a clean fast-forward. */
	pullFastForward(): Promise<Result<PullOutcome, PullError | GitError>>;
	/** Per-path staged and unstaged state, as `git status` reports it. */
	paths(): Promise<Result<PathStatus[], GitError>>;
	/** Staged authoring requires `commitOnEdit: false`. */
	stage(paths: readonly string[] | 'all'): Promise<Result<undefined, GitError>>;
	/** Commit staged changes with a user-authored message in manual mode. */
	commitStaged(
		message: string,
	): Promise<Result<{ oid: string; parent: string | undefined }, GitError>>;
	diff(options: {
		staged: boolean;
		paths: readonly string[];
	}): Promise<Result<string, GitError>>;
	log(depth: number): Promise<Result<CommitSummary[], GitError>>;
};

/** Borrowed data access; the object that opened the folder owns its lifetime. */
export type FolderAccess<TDefinition extends DataDefinition> = {
	readonly tables: {
		readonly [K in keyof TDefinition['tables']]: FileTable<
			CreateRowOf<TDefinition['tables'][K]>
		>;
	};
	readonly kv: FileKv<KvOf<TDefinition>>;
	readonly files: FolderFiles;
	readonly git: FolderGit;
	/**
	 * Publish several mutations as one admission, one application, and one
	 * history request (ADR-0482).
	 *
	 * The callback runs once, synchronously, and returns `undefined`. It only
	 * collects: there is nothing to read and nothing to await inside it, and
	 * the collector stops accepting calls when the callback returns. Bytes are
	 * copied when each mutation is collected. A callback that throws, or that
	 * returns anything (a promise included), publishes nothing.
	 *
	 * The receipt lists the steps that landed, in order, with the capture each
	 * left behind. Those captures are computed from the bytes that were
	 * collected, never read back, so a file another writer changed afterward
	 * is a different observation: read it to see it.
	 *
	 * A browser folder applies the whole batch or none of it. A folder on disk
	 * applies ordered steps and reports `Partial` when a later one fails.
	 */
	batch(
		collect: (batch: FolderBatch<TDefinition>) => undefined,
	): Promise<Result<BatchReceipt, BatchError | TableWriteError>>;
};

/**
 * Where an opened folder's files are. For showing to a person or telling
 * folders apart; file paths passed to the folder are never joined onto it.
 */
export type FolderLocation =
	/** An IndexedDB database of this origin, by name. */
	| { readonly kind: 'indexedDb'; readonly database: string }
	/** An ordinary directory, by absolute path. */
	| { readonly kind: 'directory'; readonly root: string };

export type Folder<TDefinition extends DataDefinition> =
	FolderAccess<TDefinition> & {
		readonly location: FolderLocation;
		/**
		 * Hear that files changed, as a hint to read again. The paths are the
		 * ones a change reached. There is not one call per save, calls are not
		 * ordered against other folders' saves, and a hint is never a capture.
		 * Subscribe before the first read so no change falls between them.
		 * Returns the function that stops listening; closing stops all of them.
		 */
		onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
		/**
		 * A shell over this folder's files and history. A redirection is a
		 * deliberate overwrite; a rewrite of a file the same command read is
		 * conditional on what it read. The terminal ends with the folder.
		 */
		terminal(options?: { cwd?: string }): FolderTerminal;
		/** Aborts when closing starts. */
		readonly signal: AbortSignal;
		close(): Promise<void>;
	};

/**
 * The file access a folder's tables, KV, and raw files need. `capture` is not
 * part of it: only a history that builds commits in this process captures.
 */
export type FolderBoundary = Omit<FileBoundary, 'capture'>;

/**
 * What a folder needs from its history. `createHistory` provides it for a
 * browser or Bun folder. A folder whose owner records history itself provides
 * the same observations and requests with `noteEdit` and
 * `requestAutomaticCommit` doing nothing, because that owner already knows
 * about every save it publishes.
 */
export type FolderHistory = Pick<
	History,
	| 'snapshot'
	| 'subscribe'
	| 'noteEdit'
	| 'requestAutomaticCommit'
	| 'status'
	| 'commit'
	| 'commitAndPush'
	| 'push'
	| 'fetch'
	| 'pullFastForward'
	| 'paths'
	| 'stage'
	| 'commitStaged'
	| 'diff'
	| 'log'
	| 'beginClose'
	| 'close'
>;

/** How content saves publish: through the folder's admitted file boundary. */
export type FolderContext = {
	readonly boundary: FolderBoundary;
	/** Runs admitted work; refuses after the folder starts closing. */
	admit<T, E>(
		work: () => Promise<Result<T, E>>,
	): Promise<Result<T, E | FileError>>;
	/**
	 * Publish a content operation and invalidate observations for any landed
	 * changes. Only a complete operation requests an automatic commit.
	 */
	publish: FileBoundary['apply'];
};

/**
 * What the shell is given: the same files and history as the app, with the
 * condition of each save chosen by the shell. A redirection overwrites and
 * `rm` removes whatever is there, which the public file verbs never do
 * without a capture.
 */
export type ShellAccess = {
	readonly files: {
		list: FolderFiles['list'];
		children: FolderFiles['children'];
		read(path: string): Promise<Result<FileRead, FileError>>;
		write(
			change: FileWriteIntent,
		): Promise<Result<string, FileError | ApplyError>>;
		remove(
			path: string,
			expectedSha256?: string,
		): Promise<Result<undefined, FileError | ApplyError>>;
		move(
			from: string,
			to: string,
			expectedSha256?: string,
		): Promise<Result<undefined, FileError | ApplyError>>;
		mkdir: FolderFiles['mkdir'];
		rmdir: FolderFiles['rmdir'];
	};
	readonly git: FolderGit;
};

/** File-change hints for one opened folder. */
export type FileHints = {
	/** A change this handle made: tell listeners, and whoever relays it onward. */
	emit(paths: readonly string[]): void;
	/** A change reported from elsewhere: tell listeners only. */
	receive(paths: readonly string[]): void;
	subscribe(listener: (paths: readonly string[]) => void): () => void;
	/** Stop calling this handle's listeners and drop them. Relaying continues. */
	close(): void;
};

/** `relay` carries this handle's own changes to other handles on the same files. */
export function createFileHints(
	relay?: (paths: readonly string[]) => void,
): FileHints {
	const listeners = new Set<(paths: readonly string[]) => void>();
	let closed = false;
	function receive(paths: readonly string[]) {
		// A listener may close the folder or stop another listener. The ones
		// after it are asked again before each call, so neither hears a hint it
		// was fenced from, and one that throws does not silence the rest.
		for (const listener of [...listeners]) {
			if (closed) return;
			if (listeners.has(listener))
				callObserver('change listener', listener, paths);
		}
	}
	return {
		emit(paths) {
			if (paths.length === 0) return;
			receive(paths);
			// A save that finishes while this handle closes still changed the
			// files other handles are looking at. A relay that fails is that
			// handle's missed hint, never this save's failure.
			if (relay !== undefined) callObserver('change relay', relay, paths);
		},
		receive(paths) {
			if (paths.length > 0) receive(paths);
		},
		subscribe(listener) {
			if (closed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			closed = true;
			listeners.clear();
		},
	};
}

const stepPaths = (step: FileStep | FileChange): string[] =>
	step.kind === 'move' ? [step.from, step.to] : [step.path];

/**
 * Admission and publication over one boundary and history. `signal` fences
 * new work; `settled` resolves once everything admitted before then finished.
 */
export function createFolderContext({
	boundary,
	history,
	signal,
	landed,
}: {
	boundary: FolderBoundary;
	history: Pick<FolderHistory, 'noteEdit' | 'requestAutomaticCommit'>;
	signal: AbortSignal;
	/** Paths a publication reached, whether it completed or stopped partway. */
	landed: (paths: readonly string[]) => void;
}): FolderContext & { settled(): Promise<void> } {
	const admitted = new Set<Promise<unknown>>();
	return {
		boundary,
		admit<T, E>(
			work: () => Promise<Result<T, E>>,
		): Promise<Result<T, E | FileError>> {
			if (signal.aborted) return Promise.resolve(FileError.Closed());
			const completion = Promise.withResolvers<Result<T, E | FileError>>();
			const running = completion.promise;
			admitted.add(running);
			// The caller owns the rejection; cleanup must not create a second one.
			void running.catch(() => {}).finally(() => admitted.delete(running));
			// Admitted before `work` is called. `work` runs up to its first wait
			// right here, and that part may call back into code that closes the
			// folder; closing must already find this work to wait for.
			try {
				work().then(completion.resolve, completion.reject);
			} catch (cause) {
				completion.reject(cause);
			}
			return running;
		},
		async publish(changes) {
			const result = await boundary.apply(changes);
			if (result.error === null) {
				history.noteEdit();
				history.requestAutomaticCommit();
				landed(changes.flatMap(stepPaths));
			} else if (result.error.name === 'Partial') {
				history.noteEdit();
				landed(result.error.applied.flatMap(stepPaths));
			}
			return result;
		},
		async settled() {
			await Promise.allSettled([...admitted]);
		},
	};
}

function createFolderGit(history: FolderHistory): FolderGit {
	return Object.freeze({
		get snapshot() {
			return history.snapshot;
		},
		subscribe: (listener) => history.subscribe(listener),
		status: () => history.status(),
		commit: () => history.commit(),
		commitAndPush: (options) => history.commitAndPush(options),
		push: (options) => history.push(options),
		fetch: (options) => history.fetch(options),
		pullFastForward: () => history.pullFastForward(),
		paths: () => history.paths(),
		stage: (paths) => history.stage(paths),
		commitStaged: (message) => history.commitStaged(message),
		diff: (options) => history.diff(options),
		log: (depth) => history.log(depth),
	} satisfies FolderGit);
}

function createShellAccess(
	context: FolderContext,
	git: FolderGit,
): ShellAccess {
	const { boundary, admit } = context;
	return {
		files: {
			list: () => admit(() => boundary.list()),
			children: (directory) => admit(() => boundary.children(directory)),
			read: (path) => admit(() => boundary.read(path)),
			write: (change) => {
				const intent = { ...change, bytes: ownBytes(change.bytes) };
				return admit(async () => {
					const sha256 = await hashBytes(intent.bytes);
					const applied = await context.publish([{ ...intent, sha256 }]);
					return applied.error ? applied : Ok(sha256);
				});
			},
			remove: (path, expectedSha256) =>
				admit(() =>
					context.publish([{ kind: 'remove', path, expectedSha256 }]),
				),
			move: (from, to, expectedSha256) =>
				admit(() =>
					context.publish([{ kind: 'move', from, to, expectedSha256 }]),
				),
			mkdir: (path) => admit(() => boundary.mkdir(path)),
			rmdir: (path) => admit(() => boundary.rmdir(path)),
		},
		git,
	};
}

/**
 * The terminal every folder has, over its own shell access. The shell
 * implementation is loaded when the first command runs. Commands run one at
 * a time and stop at their next step once `signal` aborts. A command holds
 * nothing between its steps: each is admitted like any other file or Git
 * call, so other writers can land in between.
 */
function createLocalTerminal(
	shell: ShellAccess,
	signal: AbortSignal,
	{ cwd = '/' }: { cwd?: string } = {},
): FolderTerminal {
	let terminal: FolderTerminal | undefined;
	let tail: Promise<unknown> = Promise.resolve();
	return {
		get cwd() {
			return terminal?.cwd ?? cwd;
		},
		exec(command, options) {
			const running = tail.then(async (): Promise<TerminalResult> => {
				if (signal.aborted)
					return { stdout: '', stderr: 'The folder is closed\n', exitCode: 1 };
				terminal ??= (await import('./terminal.js')).createFolderTerminal(
					shell,
					{ cwd },
				);
				return terminal.exec(command, {
					signal:
						options?.signal === undefined
							? signal
							: AbortSignal.any([signal, options.signal]),
				});
			});
			tail = running.catch(() => {});
			return running;
		},
	};
}

/**
 * Assemble the handle over acquired storage. `compiled` is the opener's
 * `compileFolderDefinition` result, taken before it acquired anything. No
 * argument carries `TDefinition`, so the opener names it.
 */
export function assembleFolder<TDefinition extends DataDefinition>({
	compiled,
	boundary,
	history,
	location,
	hints,
	announcePublications,
	release,
}: {
	compiled: ParsedDataDefinition;
	boundary: FolderBoundary;
	history: FolderHistory;
	location: FolderLocation;
	hints: FileHints;
	/**
	 * Whether this handle announces the paths its own saves reach. False when
	 * the storage owner announces every change itself.
	 */
	announcePublications: boolean;
	/** Releases storage after all work settles. */
	release: () => Promise<void>;
}): Folder<TDefinition> {
	const controller = new AbortController();
	let closing: Promise<void> | undefined;

	const context = createFolderContext({
		boundary,
		history,
		signal: controller.signal,
		landed: announcePublications ? (paths) => hints.emit(paths) : () => {},
	});
	const { admit } = context;

	const tables: Record<string, FileTable<unknown>> = {};
	for (const [name, parsed] of compiled.tables)
		tables[name] = createFileTable<unknown>(name, parsed, context);

	/** Publish one write and return the capture of the bytes that were given. */
	function save(
		intent: FileWriteIntent,
	): Promise<Result<FileCapture, FileError | ApplyError>> {
		return admit(async () => {
			const sha256 = await hashBytes(intent.bytes);
			const applied = await context.publish([{ ...intent, sha256 }]);
			return applied.error ? applied : Ok(fileCapture(intent.path, sha256));
		});
	}

	function refusedCapture(file: FileCapture) {
		const problem = captureProblem(file);
		return problem === undefined
			? undefined
			: FileError.InvalidPath({
					path: String((file as { path?: unknown } | null)?.path ?? ''),
					reason: problem,
				});
	}

	const files: FolderFiles = {
		list: () => admit(() => boundary.list()),
		children: (directory) => admit(() => boundary.children(directory)),
		read: (path) =>
			admit(async () => {
				const read = await boundary.read(path);
				if (read.error) return read;
				return Ok(
					Object.freeze({
						...fileCapture(path, read.data.sha256),
						bytes: read.data.bytes,
					}),
				);
			}),
		open: (path) => admit(() => boundary.open(path)),
		create: (path, content) =>
			save({ kind: 'create', path, bytes: ownBytes(content) }),
		replace: (file, content) => {
			const refused = refusedCapture(file);
			if (refused) return Promise.resolve(refused);
			// The baseline is fixed here: the capture's own hash, copied.
			const { path, sha256 } = fileCapture(file.path, file.sha256);
			return save({
				kind: 'replace',
				path,
				bytes: ownBytes(content),
				expectedSha256: sha256,
			});
		},
		remove: (file) => {
			const refused = refusedCapture(file);
			if (refused) return Promise.resolve(refused);
			const { path, sha256 } = fileCapture(file.path, file.sha256);
			return admit(() =>
				context.publish([{ kind: 'remove', path, expectedSha256: sha256 }]),
			);
		},
		move: (file, destination) => {
			const refused = refusedCapture(file);
			if (refused) return Promise.resolve(refused);
			const { path, sha256 } = fileCapture(file.path, file.sha256);
			return admit(async () => {
				const applied = await context.publish([
					{ kind: 'move', from: path, to: destination, expectedSha256: sha256 },
				]);
				// A move carries the captured bytes, so their hash is the capture's.
				return applied.error ? applied : Ok(fileCapture(destination, sha256));
			});
		},
		overwrite: (path, content) =>
			save({ kind: 'overwrite', path, bytes: ownBytes(content) }),
		mkdir: (path) => admit(() => boundary.mkdir(path)),
		rmdir: (path) => admit(() => boundary.rmdir(path)),
	};

	const git = createFolderGit(history);
	const shell = createShellAccess(context, git);

	return Object.freeze({
		tables: Object.freeze(tables) as Folder<TDefinition>['tables'],
		kv: createFileKv(compiled.kv, context) as Folder<TDefinition>['kv'],
		files: Object.freeze(files),
		git,
		batch: (collect) =>
			// The callback runs here, inside the one admission, before anything
			// is awaited. A closed folder never calls it.
			admit(
				async (): Promise<
					Result<BatchReceipt, BatchError | TableWriteError>
				> => {
					const collected = collectBatch<TDefinition>(compiled, collect);
					if (collected.error) return collected;
					if (collected.data.length === 0) return Ok(receiptOf([]));
					// Typed rows are checked against their directories before
					// anything is published, so a refusal here wrote nothing.
					const destinations = await checkRowDestinations(
						collected.data,
						boundary,
					);
					if (destinations.error) return destinations;
					const changes: BatchChange[] = [];
					for (const intent of collected.data)
						changes.push(await toChange(intent));
					const applied = await context.publish(changes);
					if (applied.error) return applied;
					return Ok(receiptOf(changes));
				},
			),
		location: Object.freeze(location),
		onFilesChanged: (listener) => hints.subscribe(listener),
		terminal: (options) =>
			createLocalTerminal(shell, controller.signal, options),
		signal: controller.signal,
		close() {
			if (closing !== undefined) return closing;
			const completion = Promise.withResolvers<void>();
			// Abort and history observers may call close again synchronously.
			// Give them this completion before notifying either one.
			closing = completion.promise;
			void (async () => {
				// Fence new file work, stop hints, and cancel network work now.
				controller.abort();
				hints.close();
				history.beginClose();
				// Saves admitted before the fence finish and start no commit; then
				// history waits for whatever of its own work was already running.
				await context.settled();
				await history.close();
				await release();
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	} satisfies Folder<TDefinition>);
}
