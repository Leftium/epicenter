/**
 * The opened folder handle every opener returns (ADR-0471, ADR-0478).
 *
 * `tables`, `kv`, `files`, and `batch` publish through one file boundary.
 * `git` observes and records history. A complete content save makes one
 * automatic commit attempt when the folder's history policy says so.
 *
 * Closing fences new file work and history requests and stops network work
 * at once. Each file operation owns its completion promise. Closing does not wait
 * for file helpers; storage applications already started return their actual
 * outcome. History work drains before storage is released. Closing makes no
 * last commit.
 */
import type {
	CreateRowOf,
	DataDefinition,
	KvOf,
	ParsedDataDefinition,
} from '@epicenter/definition';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type BatchChange,
	type BatchReceipt,
	checkRowDestinations,
	collectBatch,
	type FolderBatch,
	receiptOf,
	toChange,
} from './batch.js';
import type { FolderStorage } from './boundary.js';
import { type BatchError, FileError, type TableWriteError } from './errors.js';
import { createFiles, type FolderFiles } from './files.js';
import type { GitRemote, PathStatus } from './git/backend.js';
import type {
	CommitAndPushResult,
	CommitOutcome,
	FetchOutcome,
	FilesObservation,
	GitError,
	GitSnapshot,
	PullError,
	PullOutcome,
	PushOutcome,
} from './git/history.js';
import type { Author, CommitSummary } from './git/objects.js';
import { createKv, type FileKv } from './kv.js';
import { callObserver } from './observer.js';
import { fenceStorage } from './storage.js';
import { createTable, type FileTable } from './table.js';
import type { FolderTerminal } from './terminal.js';

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
	 * Publish several mutations as one application and one
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
		/**
		 * Fence the next storage call and drain owned Git work before release.
		 * Await each file operation that must finish before closing; close does
		 * not wait for file helpers or their publication replies.
		 */
		close(): Promise<void>;
	};

/** The history observations and requests the handle exposes. */
export type FolderHistory = FolderGit & { close(): Promise<void> };

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

/** Load one terminal per caller; the terminal owns command ordering. */
function createLocalTerminal(
	{
		storage,
		git,
		signal,
	}: { storage: FolderStorage; git: FolderGit; signal: AbortSignal },
	{ cwd = '/' }: { cwd?: string } = {},
): FolderTerminal {
	let terminal: FolderTerminal | undefined;
	let loading: Promise<FolderTerminal> | undefined;
	return {
		get cwd() {
			return terminal?.cwd ?? cwd;
		},
		async exec(command, options) {
			if (signal.aborted)
				return { stdout: '', stderr: 'The folder is closed\n', exitCode: 1 };
			loading ??= import('./terminal.js').then(({ createTerminal }) => {
				terminal = createTerminal({ storage, git }, { cwd });
				return terminal;
			});
			const loaded = await loading;
			return loaded.exec(command, {
				signal:
					options?.signal === undefined
						? signal
						: AbortSignal.any([signal, options.signal]),
			});
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
	storage: suppliedStorage,
	history,
	location,
	hints,
	release,
}: {
	compiled: ParsedDataDefinition;
	storage: FolderStorage;
	history: FolderHistory;
	location: FolderLocation;
	hints: FileHints;
	/** Releases this attachment after owned Git work settles. */
	release: () => Promise<void>;
}): Folder<TDefinition> {
	const controller = new AbortController();
	let closing: Promise<void> | undefined;

	const storage = fenceStorage(suppliedStorage, controller.signal);
	const tables: Record<string, FileTable<unknown>> = {};
	for (const definition of compiled.tables.values())
		tables[definition.name] = createTable<unknown>({ storage }, { definition });
	const files = createFiles({ storage });
	const git = createFolderGit(history);

	return Object.freeze({
		tables: Object.freeze(tables) as Folder<TDefinition>['tables'],
		kv: createKv(
			{ storage },
			{ definition: compiled.kv },
		) as Folder<TDefinition>['kv'],
		files,
		git,
		async batch(collect) {
			if (controller.signal.aborted) return FileError.Closed();
			const collected = collectBatch<TDefinition>(compiled, collect);
			if (collected.error) return collected;
			if (collected.data.length === 0) return Ok(receiptOf([]));
			// Typed rows are checked against their directories before
			// anything is published, so a refusal here wrote nothing.
			const destinations = await checkRowDestinations(collected.data, storage);
			if (destinations.error) return destinations;
			const changes: BatchChange[] = [];
			for (const intent of collected.data) changes.push(await toChange(intent));
			const applied = await storage.apply(changes);
			if (applied.error) return applied;
			return Ok(receiptOf(changes));
		},
		location: Object.freeze(location),
		onFilesChanged: (listener) => hints.subscribe(listener),
		terminal: (options) =>
			createLocalTerminal({ storage, git, signal: controller.signal }, options),
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
				await history.close();
				await release();
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	} satisfies Folder<TDefinition>);
}
