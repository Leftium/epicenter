/**
 * The opened folder handle shared by the browser and native openers (ADR-0471).
 *
 * `tables`, `kv`, and `files` publish through one file boundary. `git`
 * observes and records history. Complete content saves request an
 * automatic commit when `commitOnEdit` is true.
 * Closing fences new work immediately, settles admitted operations and local
 * commit passes, cancels outgoing network work, and then releases storage.
 */
import { Ok, type Result } from 'wellcrafted/result';
import {
	compileData,
	type ParsedDataDefinition,
} from '../data/definition/compile.js';
import type {
	CreateRowOf,
	DataDefinition,
	KvOf,
} from '../data/definition/declaration.js';
import type { FileBoundary, FileListing, FileRead } from './boundary.js';
import { type ApplyError, FileError } from './errors.js';
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
import { createFileTable, type FileTable } from './table.js';
import {
	captureVersion,
	type FileExpectation,
	type FileVersion,
} from './version.js';

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

export type FolderFiles = {
	list(): Promise<Result<FileListing, FileError>>;
	children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>>;
	read(path: string): Promise<Result<FileRead, FileError>>;
	/** Stable bytes for consumption (ADR-0466). */
	open(path: string): Promise<Result<Blob, FileError>>;
	/** Write at an exact literal path, then request history under the folder policy. */
	write(
		path: string,
		content: string | Uint8Array,
		options: { readonly expected: FileExpectation },
	): Promise<Result<FileVersion, FileError | ApplyError>>;
	remove(
		path: string,
		options: { readonly expected: FileExpectation },
	): Promise<Result<undefined, FileError | ApplyError>>;
	move(
		from: string,
		to: string,
		options: { readonly expected: FileExpectation },
	): Promise<Result<undefined, FileError | ApplyError>>;
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
	 * head either way. Never requests a push; a pass it shares with a
	 * save's automatic request pushes because of that request.
	 */
	commit(): Promise<CommitOutcome>;
	/**
	 * `signal` only stops this caller waiting (`stoppedWaiting`): commit and
	 * push passes are shared, so the transport keeps running. Closing the
	 * folder is what aborts owned network work.
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

/** Borrowed data access; the object that acquired storage owns its lifetime. */
export type FolderAccess<TDefinition extends DataDefinition> = {
	readonly tables: {
		readonly [K in keyof TDefinition['tables']]: FileTable<
			CreateRowOf<TDefinition['tables'][K]>
		>;
	};
	readonly kv: FileKv<KvOf<TDefinition>>;
	readonly files: FolderFiles;
	readonly git: FolderGit;
};

export type Folder<TDefinition extends DataDefinition> =
	FolderAccess<TDefinition> & {
		/** Aborts when closing starts. */
		readonly signal: AbortSignal;
		close(): Promise<void>;
	};

/** How content saves publish: through the folder's admitted file boundary. */
export type FolderContext = {
	readonly boundary: FileBoundary;
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
 * Compile a definition for file storage. Declarations the file implementation
 * cannot honor are refused, not ignored: a Yjs body codec (the body is
 * Markdown text), and reference fields (rename repairs no references).
 */
export function compileFolderDefinition(
	definition: DataDefinition,
): ParsedDataDefinition {
	const compiled = compileData(definition);
	if (compiled.error !== null)
		throw new Error(compiled.error.message, { cause: compiled.error });
	for (const [name, table] of [
		...compiled.data.tables,
		['kv', compiled.data.kv] as const,
	]) {
		if (table.body !== undefined)
			throw new Error(
				`Table '${name}' declares a Yjs body codec. A file folder stores the body as Markdown text; remove the codec from this definition.`,
			);
		for (const [field, declared] of table.fields)
			if (declared.reference !== null)
				throw new Error(
					`Field '${name}.${field}' is a reference to '${declared.reference}'. File folders do not support reference fields yet: renaming a row would not repair them.`,
				);
	}
	return compiled.data;
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
	release,
}: {
	compiled: ParsedDataDefinition;
	boundary: FileBoundary;
	history: History;
	/** Releases storage after all work settles. */
	release: () => Promise<void>;
}): Folder<TDefinition> {
	const controller = new AbortController();
	const admitted = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;

	function admit<T, E>(
		work: () => Promise<Result<T, E>>,
	): Promise<Result<T, E | FileError>> {
		if (controller.signal.aborted) return Promise.resolve(FileError.Closed());
		const running = work();
		admitted.add(running);
		// The caller owns the rejection; cleanup must not create a second one.
		void running.catch(() => {}).finally(() => admitted.delete(running));
		return running;
	}

	const context: FolderContext = {
		boundary,
		admit,
		async publish(changes) {
			const result = await boundary.apply(changes);
			if (result.error === null || result.error.name === 'Partial')
				history.noteEdit();
			if (result.error === null) history.requestAutomaticCommit();
			return result;
		},
	};

	const tables: Record<string, FileTable<unknown>> = {};
	for (const [name, parsed] of compiled.tables)
		tables[name] = createFileTable<unknown>(name, parsed, context);

	const encoder = new TextEncoder();

	const files: FolderFiles = {
		list: () => admit(() => boundary.list()),
		children: (directory) => admit(() => boundary.children(directory)),
		read: (path) => admit(() => boundary.read(path)),
		open: (path) => admit(() => boundary.open(path)),
		write: (path, content, { expected }) => {
			// Own the bytes before any await: the caller may reuse its array, and
			// the saved bytes must be the ones the version was computed from.
			// `new Uint8Array(view)` copies; `slice` on a Node Buffer would alias.
			const bytes =
				typeof content === 'string'
					? encoder.encode(content)
					: new Uint8Array(content);
			return admit(async () => {
				const version = await captureVersion(bytes);
				const applied = await context.publish([
					{ kind: 'write', path, bytes, version, expected },
				]);
				return applied.error ? applied : Ok(version);
			});
		},
		remove: (path, { expected }) =>
			admit(() => context.publish([{ kind: 'remove', path, expected }])),
		move: (from, to, { expected }) =>
			admit(() => context.publish([{ kind: 'move', from, to, expected }])),
		mkdir: (path) => admit(() => boundary.mkdir(path)),
		rmdir: (path) => admit(() => boundary.rmdir(path)),
	};

	const git: FolderGit = {
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
	};

	return Object.freeze({
		tables: Object.freeze(tables) as Folder<TDefinition>['tables'],
		kv: createFileKv(compiled.kv, context) as Folder<TDefinition>['kv'],
		files: Object.freeze(files),
		git: Object.freeze(git),
		signal: controller.signal,
		close() {
			closing ??= (async () => {
				controller.abort();
				// History fences and cancels network work immediately; admitted file
				// operations and local commit passes settle before storage is released.
				const historyClosed = history.close();
				await Promise.allSettled([...admitted]);
				await historyClosed;
				await release();
			})();
			return closing;
		},
	});
}
