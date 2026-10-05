/**
 * The opened folder handle every opener returns (ADR-0471, ADR-0478).
 *
 * `tables`, `kv`, and `files` publish through one file boundary, one file
 * change per operation. A caller that needs several changes makes several
 * calls; each one that succeeded stays published when a later one fails.
 * `git` observes and records history. A complete content save makes one
 * automatic commit attempt when the folder's history policy says so.
 *
 * Closing fences new file work and history requests and stops network work
 * at once. Each file operation owns its completion promise. Closing does not wait
 * for file helpers; storage applications already started return their actual
 * outcome. History work drains before storage is released. Closing makes no
 * last commit.
 */
import type { CreateRowOf, KvOf } from '@epicenter/definition';
import type { Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import type { FolderDefinition } from './definition.js';
import { createFiles, type FolderFiles } from './files.js';
import type { GitRemote, PathStatus } from './git/backend.js';
import type {
	CommitAndPushResult,
	CommitOutcome,
	FetchOutcome,
	FilesObservation,
	GitError,
	GitSnapshot,
	MergeConflictPolicy,
	MergeError,
	MergeOutcome,
	PullError,
	PullOutcome,
	PushOutcome,
	RecoverOutcome,
	StagedCommit,
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
	 * Whether complete content saves request automatic local commits.
	 * Transfers remain explicit. Fixed for this handle's lifetime. Default `true`.
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
	/**
	 * Merge the fetched remote head into a clean folder: a fast-forward when
	 * possible, otherwise one commit with the branch head and the fetched head
	 * as parents. Root `kv.json` merges by key; other files by Git's rules.
	 * A refusal changes no file, index entry, or ref, and by default so does a
	 * conflict. Never pushes.
	 *
	 * With `{ conflicts: 'leave' }`, which requires `commitOnEdit: false`, a
	 * conflicted merge is published unfinished instead (`conflicted`): files
	 * with conflict markers, unmerged index stages, and Git's merge state,
	 * with the branch unmoved. Stage each resolution, then `commitStaged`
	 * records the merge commit. A file against a directory is still refused.
	 * Browser, directory, and desktop folders all merge.
	 */
	mergeIncoming(
		options?: MergeConflictPolicy,
	): Promise<Result<MergeOutcome, MergeError | PullError | GitError>>;
	/**
	 * Finish or clear the incoming update in `snapshot.pendingIncoming`, only
	 * because it is asked for. An `unadmitted` (empty) record is removed:
	 * `admissionCleared`. A branch already at the published commit is cleared
	 * without writing a file: `cleared`. Over the admitted head, each changed
	 * path at its before state is written and each at its after state is left,
	 * removals first, then the index and the branch: `completed`. A path, the
	 * index, the branch, or an unreadable record in neither state is
	 * `RecoveryRefused`, names it, and writes nothing; the update stays
	 * pending. A step whose outcome is unknown is `Unconfirmed` and leaves it
	 * pending too. Status is observed again afterward, never assumed clean.
	 * Nothing retries. Browser and desktop folders retain their own incoming
	 * record and evaluate current paths again on each explicit recovery.
	 */
	recoverIncoming(): Promise<Result<RecoverOutcome, PullError | GitError>>;
	/** Per-path staged and unstaged state, as `git status` reports it. */
	paths(): Promise<Result<PathStatus[], GitError>>;
	/**
	 * Staged authoring requires `commitOnEdit: false`. Staging an unmerged
	 * path resolves it, whatever its bytes.
	 */
	stage(paths: readonly string[] | 'all'): Promise<Result<undefined, GitError>>;
	/**
	 * Commit staged changes with a user-authored message in manual mode. With
	 * a merge in progress the commit finishes it, with the branch head and
	 * `snapshot.merging.incoming` as parents; while a path is still unmerged
	 * it is `Unmerged` and writes nothing.
	 */
	commitStaged(message: string): Promise<Result<StagedCommit, GitError>>;
	diff(options: {
		staged: boolean;
		paths: readonly string[];
	}): Promise<Result<string, GitError>>;
	log(depth: number): Promise<Result<CommitSummary[], GitError>>;
};

/** Borrowed data access; the object that opened the folder owns its lifetime. */
export type FolderAccess<TDefinition extends FolderDefinition> = {
	readonly tables: {
		readonly [K in keyof TDefinition['tables']]: FileTable<
			CreateRowOf<TDefinition['tables'][K]>
		>;
	};
	readonly kv: FileKv<KvOf<TDefinition>>;
	readonly files: FolderFiles;
	readonly git: FolderGit;
};

/**
 * Where an opened folder's files are. For showing to a person or telling
 * folders apart; file paths passed to the folder are never joined onto it.
 */
export type FolderLocation =
	/** A directory of this origin's private file system, by its path from the root. */
	| { readonly kind: 'opfs'; readonly directory: string }
	/** An ordinary directory, by absolute path. */
	| { readonly kind: 'directory'; readonly root: string };

export type Folder<TDefinition extends FolderDefinition> =
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
		mergeIncoming: (options) => history.mergeIncoming(options),
		recoverIncoming: () => history.recoverIncoming(),
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
 * Assemble the handle over acquired storage. `prepared` is the opener's
 * `prepareFolderDefinition` result, taken before it acquired anything: the
 * snapshot every table and the KV read through, never the declaration the
 * opener was handed. No argument carries `TDefinition`, so the opener names
 * it.
 */
export function assembleFolder<TDefinition extends FolderDefinition>({
	prepared,
	storage: suppliedStorage,
	history,
	location,
	hints,
	release,
}: {
	prepared: FolderDefinition;
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
	// A table's key is its name and its directory.
	for (const [name, table] of Object.entries(prepared.tables))
		tables[name] = createTable<unknown>({ storage }, name, table.fields);
	const files = createFiles({ storage });
	const git = createFolderGit(history);

	return Object.freeze({
		tables: Object.freeze(tables) as Folder<TDefinition>['tables'],
		kv: createKv({ storage }, prepared.kv) as Folder<TDefinition>['kv'],
		files,
		git,
		location: Object.freeze(location),
		onFilesChanged: (listener: (paths: readonly string[]) => void) =>
			hints.subscribe(listener),
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
