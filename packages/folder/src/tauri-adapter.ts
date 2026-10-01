/**
 * The desktop adapter: a folder owned by the desktop shell.
 *
 * The shell's Rust side holds the directory: it publishes files, records Git
 * history, and shares one owner between every window. This adapter attaches a
 * page to a folder the shell registered and returns the same folder handle the
 * browser opener returns. The page names the folder's ID and nothing else; the
 * root, the author, the remote, and the commit policy are the shell's, and
 * `browser` options do not apply here.
 *
 * This module exports the opener alone. `tauri.ts` is the public entry; the
 * automatic entry loads this module directly.
 *
 * Outside the desktop app this adapter refuses. Inside it, a missing plugin, a
 * window without permission, an unknown folder, or another protocol version
 * is returned as the refusal it is. Nothing here opens browser storage.
 *
 * Closing the handle detaches this page. It does not close the folder: saves
 * the page already made still land and are still committed, and other windows
 * carry on.
 *
 * An `invoke` that fails after it was sent leaves the outcome unknown. Reads
 * report that as an ordinary failure. Anything that could have changed files
 * or history reports `Unconfirmed` and is never retried here.
 *
 * This module loads no Git implementation and no IndexedDB store.
 */

import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileChange, FileRead } from './boundary.js';
import type { OpenFolder } from './contract.js';
import { compileFolderDefinition } from './definition.js';
import {
	ApplyError,
	describe,
	FileError,
	type FileStep,
	OpenFolderError,
} from './errors.js';
import {
	assembleFolder,
	createFileHints,
	createFolderContext,
	createFolderGit,
	createShellAccess,
	type FolderBoundary,
	type FolderHistory,
} from './folder.js';
import type { StatusCode } from './git/backend.js';
import { GitError, PullError } from './git/errors.js';
import type {
	CommitOutcome,
	GitSnapshot,
	PullOutcome,
	PushOutcome,
} from './git/history.js';
import {
	commands,
	events,
	FOLDER_PROTOCOL,
	type ApplyError as WireApplyError,
	type CommitOutcome as WireCommitOutcome,
	type FileChange as WireFileChange,
	type FileError as WireFileError,
	type FileExpectation as WireFileExpectation,
	type FileStep as WireFileStep,
	type GitError as WireGitError,
	type GitSnapshot as WireGitSnapshot,
	type PullError as WirePullError,
	type PullOutcome as WirePullOutcome,
	type PushOutcome as WirePushOutcome,
} from './native/bindings.gen.js';
import { callObserver } from './observer.js';
import type { FolderTerminal, TerminalResult } from './terminal.js';
import type { FileExpectation } from './version.js';

type Wire<T, E> = { data: T; error: null } | { data: null; error: E };

/** A settled command, or the reason no reply arrived. */
type Reply<T, E> =
	| { readonly sent: true; readonly settled: 'done'; readonly data: T }
	| { readonly sent: true; readonly settled: 'refused'; readonly error: E }
	| { readonly sent: false; readonly cause: unknown };

/** The generated commands throw only when the transport itself fails. */
async function call<W extends Wire<unknown, unknown>>(
	request: Promise<W>,
): Promise<
	Reply<Extract<W, { error: null }>['data'], NonNullable<W['error']>>
> {
	try {
		const reply = await request;
		// Tauri also rejects with strings for missing commands or permissions.
		// Generated bindings cast every non-Error rejection to the Rust error
		// type; a primitive is not an acknowledged domain refusal.
		if (
			reply.error !== null &&
			(typeof reply.error !== 'object' || !('name' in reply.error))
		)
			return { sent: false, cause: reply.error };
		return reply.error === null
			? { sent: true, settled: 'done', data: reply.data }
			: {
					sent: true,
					settled: 'refused',
					error: reply.error as NonNullable<W['error']>,
				};
	} catch (cause) {
		return { sent: false, cause };
	}
}

const orUndefined = <T>(value: T | null): T | undefined =>
	value === null ? undefined : value;

function expectationFromWire(expected: WireFileExpectation): FileExpectation {
	if (expected.kind === 'version')
		return { sha256: expected.sha256, size: expected.size };
	return expected.kind;
}

function expectationToWire(expected: FileExpectation): WireFileExpectation {
	if (expected === 'absent' || expected === 'any') return { kind: expected };
	return { kind: 'version', sha256: expected.sha256, size: expected.size };
}

function fileError(error: WireFileError): FileError {
	switch (error.name) {
		case 'InvalidPath':
			return FileError.InvalidPath(error).error;
		case 'NotFound':
			return FileError.NotFound(error).error;
		case 'Conflict':
			return FileError.Conflict({
				path: error.path,
				expected: expectationFromWire(error.expected),
				actual: orUndefined(error.actual),
			}).error;
		case 'NotAFile':
			return FileError.NotAFile(error).error;
		case 'NotADirectory':
			return FileError.NotADirectory(error).error;
		case 'DirectoryNotEmpty':
			return FileError.DirectoryNotEmpty(error).error;
		case 'Io':
			return FileError.Io(error).error;
		case 'Closed':
			return FileError.Closed().error;
		case 'Unconfirmed':
			return FileError.Unconfirmed(error).error;
		// Both are refusals before any write: the session or lease the call
		// named is not one the owner accepts.
		case 'LeaseEnded':
		case 'Denied':
			return FileError.Io({
				path: '',
				operation: 'reach the folder for',
				cause: error.reason,
			}).error;
	}
}

function applyError(error: WireApplyError): FileError | ApplyError {
	if (error.name === 'Refused') return fileError(error.error);
	if (error.name === 'Unconfirmed') return FileError.Unconfirmed(error).error;
	return ApplyError.Partial({
		applied: error.applied as FileStep[],
		failed: error.failed as FileStep,
		error: fileError(error.error),
		notAttempted: error.notAttempted as FileStep[],
	}).error;
}

function gitError(error: WireGitError, operation: string): GitError {
	switch (error.name) {
		case 'Unconfirmed':
			return GitError.Unconfirmed(error).error;
		case 'Failed':
			return GitError.Failed(error).error;
		case 'Closed':
			return GitError.Closed().error;
		case 'Denied':
			return GitError.Failed({ operation, cause: error.reason }).error;
		case 'NoRemote':
			return GitError.NoRemote().error;
		case 'InvalidMessage':
			return GitError.InvalidMessage(error).error;
		case 'NothingToCommit':
			return GitError.NothingToCommit().error;
		case 'AutomaticHistory':
			return GitError.AutomaticHistory().error;
		case 'BranchMoved':
			return GitError.BranchMoved({
				expected: orUndefined(error.expected),
				actual: orUndefined(error.actual),
			}).error;
	}
}

function pullError(error: WirePullError): PullError | GitError {
	switch (error.name) {
		case 'Git':
			return gitError(error.error, 'pull');
		case 'NoFetchedHead':
			return PullError.NoFetchedHead().error;
		case 'Blocked':
			return PullError.Blocked(error).error;
		case 'Diverged':
			return PullError.Diverged(error).error;
		case 'Dirty':
			return PullError.Dirty(error).error;
		case 'StagedChanges':
			return PullError.StagedChanges().error;
		case 'Collision':
			return PullError.Collision(error).error;
		case 'Unrepresentable':
			return PullError.Unrepresentable(error).error;
		case 'Refused':
			return PullError.Refused({ error: fileError(error.error) }).error;
		case 'Partial':
			return PullError.Partial({
				applied: error.applied as WireFileStep[] as FileStep[],
				error: fileError(error.error),
			}).error;
		case 'BranchMoved':
			return PullError.BranchMoved({
				actual: orUndefined(error.actual),
				filesApplied: error.filesApplied,
			}).error;
		case 'IndexFailed':
			return PullError.IndexFailed(error).error;
	}
}

function commitOutcome(outcome: WireCommitOutcome): CommitOutcome {
	switch (outcome.status) {
		case 'committed':
			return {
				...outcome,
				parent: orUndefined(outcome.parent),
				indexWarning: orUndefined(outcome.indexWarning),
			};
		case 'unchanged':
			return {
				status: 'unchanged',
				head: orUndefined(outcome.head),
				indexWarning: orUndefined(outcome.indexWarning),
			};
		case 'branchMoved':
			return {
				status: 'branchMoved',
				candidate: outcome.candidate,
				expected: orUndefined(outcome.expected),
				actual: orUndefined(outcome.actual),
			};
		default:
			return outcome;
	}
}

function pushOutcome(outcome: WirePushOutcome): PushOutcome {
	if (outcome.status === 'cancelled')
		return { status: 'cancelled', oid: orUndefined(outcome.oid) };
	return outcome;
}

function pullOutcome(outcome: WirePullOutcome): PullOutcome {
	switch (outcome.status) {
		case 'upToDate':
			return { status: 'upToDate', head: orUndefined(outcome.head) };
		case 'ahead':
			return outcome;
		case 'fastForwarded':
			return { ...outcome, from: orUndefined(outcome.from) };
	}
}

function observation<W, T>(
	observed: WireObservation<W>,
	value: (wire: W) => T,
): Observed<T> {
	if (observed.state === 'unknown')
		return { state: 'unknown', error: orUndefined(observed.error) };
	return {
		state: 'observed',
		value: value(observed.value),
		checkedAt: observed.checkedAt,
		stale: observed.stale,
		error: orUndefined(observed.error),
	};
}

type WireObservation<W> =
	| { state: 'unknown'; error: string | null }
	| {
			state: 'observed';
			value: W;
			checkedAt: number;
			stale: boolean;
			error: string | null;
	  };

type Observed<T> =
	| { readonly state: 'unknown'; readonly error: string | undefined }
	| {
			readonly state: 'observed';
			readonly value: T;
			readonly checkedAt: number;
			readonly stale: boolean;
			readonly error: string | undefined;
	  };

function snapshotFromWire(wire: WireGitSnapshot): GitSnapshot {
	return Object.freeze({
		branch: wire.branch,
		remote: orUndefined(wire.remote),
		commitOnEdit: wire.commitOnEdit,
		files: observation(wire.files, (files) => ({
			head: orUndefined(files.head),
			changes: files.changes,
		})),
		sync: observation(wire.sync, (sync) => ({
			head: orUndefined(sync.head),
			remote: orUndefined(sync.remote),
			ahead: sync.ahead,
			behind: sync.behind,
		})),
		activity: wire.activity,
		lastCommit:
			wire.lastCommit === null
				? undefined
				: { ...commitOutcome(wire.lastCommit.result), at: wire.lastCommit.at },
		lastPush:
			wire.lastPush === null
				? undefined
				: { ...pushOutcome(wire.lastPush.result), at: wire.lastPush.at },
		lastFetch:
			wire.lastFetch === null
				? undefined
				: {
						at: wire.lastFetch.at,
						result:
							wire.lastFetch.result.status === 'ok'
								? Ok({
										status: 'fetched' as const,
										oid: orUndefined(wire.lastFetch.result.value.oid),
									})
								: Err(gitError(wire.lastFetch.result.error, 'fetch')),
					},
		lastPull:
			wire.lastPull === null
				? undefined
				: {
						at: wire.lastPull.at,
						result:
							wire.lastPull.result.status === 'ok'
								? Ok(pullOutcome(wire.lastPull.result.value))
								: Err(pullError(wire.lastPull.result.error)),
					},
		closed: wire.closed,
	});
}

/** JavaScript's own string order, which the browser store lists in. */
const sorted = (names: readonly string[]) => [...names].sort();

function changeToWire(change: FileChange): WireFileChange {
	switch (change.kind) {
		case 'write':
			return {
				kind: 'write',
				path: change.path,
				// The owner hashes these bytes itself; it takes no version on trust.
				bytes: Array.from(change.bytes),
				expected: expectationToWire(change.expected),
			};
		case 'remove':
			return {
				kind: 'remove',
				path: change.path,
				expected: expectationToWire(change.expected),
			};
		case 'move':
			return {
				kind: 'move',
				from: change.from,
				to: change.to,
				expected: expectationToWire(change.expected),
			};
	}
}

/**
 * `lease` names the terminal lease the caller holds while it runs one
 * command, or `null` for ordinary calls.
 */
function createBoundary(
	session: number,
	lease: () => number | null,
): FolderBoundary {
	const unsent = (path: string, operation: string, cause: unknown) =>
		FileError.Io({ path, operation, cause });

	const toRead = (read: {
		bytes: number[];
		version: FileRead['version'];
	}): FileRead => ({
		bytes: Uint8Array.from(read.bytes),
		version: read.version,
	});

	async function children(directory: string) {
		const result = await call(commands.children(session, directory));
		if (!result.sent) return unsent(directory, 'list', result.cause);
		if (result.settled === 'refused') return Err(fileError(result.error));
		return Ok({
			files: sorted(result.data.files),
			directories: sorted(result.data.directories),
		});
	}

	async function read(path: string): Promise<Result<FileRead, FileError>> {
		const result = await call(commands.read(session, path));
		if (!result.sent) return unsent(path, 'read', result.cause);
		if (result.settled === 'refused') return Err(fileError(result.error));
		return Ok(toRead(result.data));
	}

	return {
		async list() {
			const result = await call(commands.list(session));
			if (!result.sent) return unsent('', 'enumerate', result.cause);
			if (result.settled === 'refused') return Err(fileError(result.error));
			const { files, directories } = result.data;
			return Ok({
				files: [...files].sort((a, b) =>
					a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
				),
				directories: sorted(directories),
			});
		},
		children,
		read,
		async readMany(paths) {
			const result = await call(commands.readMany(session, [...paths]));
			if (!result.sent) return unsent('', 'read', result.cause);
			if (result.settled === 'refused') return Err(fileError(result.error));
			const reads = new Map<string, Result<FileRead, FileError>>();
			result.data.forEach((entry, index) => {
				reads.set(
					paths[index] as string,
					entry.status === 'ok'
						? Ok(toRead(entry.value))
						: Err(fileError(entry.error)),
				);
			});
			return Ok(reads);
		},
		async open(path) {
			// The bytes are copied into memory, so replacing the path later does
			// not change what the consumer receives (ADR-0466).
			const found = await read(path);
			if (found.error) return found;
			return Ok(new Blob([found.data.bytes as Uint8Array<ArrayBuffer>]));
		},
		async apply(changes) {
			const first = changes[0];
			const result = await call(
				commands.apply(session, changes.map(changeToWire), lease()),
			);
			// No reply: the batch may have been published. It is sent once.
			if (!result.sent)
				return FileError.Unconfirmed({
					path:
						first === undefined
							? ''
							: first.kind === 'move'
								? first.from
								: first.path,
					operation: 'publishing to',
					cause: result.cause,
				});
			if (result.settled === 'refused') return Err(applyError(result.error));
			return Ok(undefined);
		},
		async mkdir(path) {
			const result = await call(commands.mkdir(session, path, lease()));
			if (!result.sent)
				return FileError.Unconfirmed({
					path,
					operation: 'creating',
					cause: result.cause,
				});
			if (result.settled === 'refused') return Err(fileError(result.error));
			return Ok(undefined);
		},
		async rmdir(path) {
			const result = await call(commands.rmdir(session, path, lease()));
			if (!result.sent)
				return FileError.Unconfirmed({
					path,
					operation: 'removing',
					cause: result.cause,
				});
			if (result.settled === 'refused') return Err(fileError(result.error));
			return Ok(undefined);
		},
	};
}

/**
 * Stop this caller waiting when its signal aborts. The owner's passes are
 * shared by every window, so a caller's signal never stops the work itself.
 */
function until<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	stopped: () => T,
): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.resolve(stopped());
	return new Promise<T>((resolve) => {
		const abort = () => resolve(stopped());
		signal.addEventListener('abort', abort, { once: true });
		void promise.then((value) => {
			signal.removeEventListener('abort', abort);
			resolve(value);
		});
	});
}

/**
 * History as the shell's owner reports it. The owner commits every save it
 * publishes, so `noteEdit` and `requestAutomaticCommit` have nothing to do.
 */
function createHistory(
	session: number,
	snapshots: Snapshots,
	client: Client,
	lease: () => number | null,
): FolderHistory {
	type Pass = { outcome: CommitOutcome; followingPush: number | undefined };
	const pass = (outcome: CommitOutcome): Pass => ({
		outcome,
		followingPush: undefined,
	});
	const closed = () => GitError.Closed();

	async function commitPass(): Promise<Pass> {
		const result = await call(commands.commit(session, lease()));
		if (!result.sent)
			return pass({ status: 'unconfirmed', error: describe(result.cause) });
		if (result.settled === 'refused')
			return pass(
				result.error.name === 'Closed'
					? { status: 'closed' }
					: {
							status: 'failed',
							error: gitError(result.error, 'commit').message,
						},
			);
		return {
			outcome: commitOutcome(result.data.outcome),
			followingPush: orUndefined(result.data.followingPush),
		};
	}

	async function pushPass(joining: number | undefined): Promise<PushOutcome> {
		const result = await call(commands.push(session, joining ?? null));
		if (!result.sent)
			return { status: 'unconfirmed', error: describe(result.cause) };
		// The owner refused before it pinned a commit: nothing was attempted,
		// so there is no commit to name.
		if (result.settled === 'refused')
			return result.error.name === 'Closed'
				? { status: 'closed' }
				: {
						status: 'skipped',
						reason: gitError(result.error, 'push').message,
					};
		return pushOutcome(result.data);
	}

	/** A command whose reply is a Git result, with nothing changed if it is lost. */
	function observe<T, U>(
		operation: string,
		request: () => Promise<Wire<T, WireGitError>>,
		value: (data: T) => U,
	): Promise<Result<U, GitError>> {
		return client.local(closed, async () => {
			const result = await call(request());
			if (!result.sent)
				return GitError.Failed({ operation, cause: result.cause });
			if (result.settled === 'refused')
				return Err(gitError(result.error, operation));
			return Ok(value(result.data));
		});
	}

	/** A command that may have changed history when its reply is lost. */
	async function change<T, U>(
		operation: string,
		request: () => Promise<Wire<T, WireGitError>>,
		value: (data: T) => U,
	): Promise<Result<U, GitError>> {
		const result = await call(request());
		if (!result.sent)
			return GitError.Unconfirmed({ operation, cause: result.cause });
		if (result.settled === 'refused')
			return Err(gitError(result.error, operation));
		return Ok(value(result.data));
	}

	const stoppedPush = (): PushOutcome => ({ status: 'stoppedWaiting' });
	const closedPush = (): PushOutcome => ({ status: 'closed' });

	return {
		get snapshot() {
			return snapshots.current;
		},
		subscribe: (listener) => snapshots.subscribe(listener),
		noteEdit() {},
		requestAutomaticCommit() {},
		status: () =>
			observe(
				'status',
				() => commands.status(session, lease()),
				(files) => ({ head: orUndefined(files.head), changes: files.changes }),
			),
		commit: async () =>
			(await client.local(() => pass({ status: 'closed' }), commitPass))
				.outcome,
		async commitAndPush({ signal } = {}) {
			const settled = await until(
				client.local(() => pass({ status: 'closed' }), commitPass),
				signal,
				() => pass({ status: 'stoppedWaiting' }),
			);
			const commit = settled.outcome;
			switch (commit.status) {
				case 'committed':
				case 'unchanged':
					break;
				// The commit's outcome is unknown or still pending, and a pass a
				// save requested pushes on its own: the push cannot be called
				// skipped.
				case 'unconfirmed':
					return {
						commit,
						push: { status: 'unconfirmed', error: commit.error },
					};
				case 'stoppedWaiting':
					return { commit, push: { status: 'stoppedWaiting' } };
				case 'closed':
					return { commit, push: { status: 'closed' } };
				default:
					return {
						commit,
						push: { status: 'skipped', reason: 'the commit did not complete' },
					};
			}
			if (snapshots.current.remote === undefined)
				return { commit, push: { status: 'noRemote' } };
			// A save-requested pass already started a push: wait for that one.
			const push = await client.network(closedPush, stoppedPush, signal, () =>
				pushPass(settled.followingPush),
			);
			return { commit, push };
		},
		push: ({ signal } = {}) =>
			client.network(closedPush, stoppedPush, signal, () =>
				pushPass(undefined),
			),
		fetch: ({ signal } = {}) =>
			client.network(
				closed,
				() => GitError.StoppedWaiting({ operation: 'fetch' }),
				signal,
				() =>
					change(
						'fetch',
						() => commands.fetch(session),
						(fetched) => ({
							status: 'fetched' as const,
							oid: orUndefined(fetched.oid),
						}),
					),
			),
		pullFastForward: () =>
			client.local(closed, async () => {
				const result = await call(commands.pullFastForward(session, lease()));
				if (!result.sent)
					return GitError.Unconfirmed({
						operation: 'pull',
						cause: result.cause,
					});
				if (result.settled === 'refused') return Err(pullError(result.error));
				return Ok(pullOutcome(result.data));
			}),
		paths: () =>
			observe(
				'status',
				() => commands.paths(session),
				(paths) =>
					paths.map((path) => ({
						path: path.path,
						index: path.index as StatusCode,
						worktree: path.worktree as StatusCode,
					})),
			),
		stage: (paths) =>
			client.local(closed, () =>
				change(
					'add',
					() => commands.stage(session, paths === 'all' ? null : [...paths]),
					() => undefined,
				),
			),
		commitStaged: (message) =>
			client.local(closed, () =>
				change(
					'commit',
					() => commands.commitStaged(session, message),
					(staged) => ({ oid: staged.oid, parent: orUndefined(staged.parent) }),
				),
			),
		diff: ({ staged, paths }) =>
			observe(
				'diff',
				() => commands.diff(session, staged, [...paths]),
				(text) => text,
			),
		log: (depth) =>
			observe(
				'log',
				() => commands.log(session, depth),
				(log) => log,
			),
		beginClose: () => client.fence(),
		close: () => client.close(),
	};
}

/**
 * This page's use of the folder: one lifetime for its Git calls and its
 * terminals. `fence` refuses new ones all at once and stops this page waiting
 * for network work. `close` also waits for local work that was already
 * running, so the session is not detached under it. Network
 * work belongs to the owner and keeps running there; closing only stops this
 * page waiting for it.
 */
type Client = {
	/** Aborts when this page's folder starts closing. */
	readonly signal: AbortSignal;
	/** Local work: refused once closing, otherwise waited for by `close`. */
	local<T>(closed: () => T, work: () => Promise<T>): Promise<T>;
	/**
	 * Network work: refused once closing. The caller's signal, or closing,
	 * stops the wait and nothing else.
	 */
	network<T>(
		closed: () => T,
		stopped: () => T,
		signal: AbortSignal | undefined,
		work: () => Promise<T>,
	): Promise<T>;
	fence(): void;
	close(): Promise<void>;
};

function createClient(): Client {
	const controller = new AbortController();
	const running = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;
	return {
		signal: controller.signal,
		local(closed, work) {
			if (controller.signal.aborted) return Promise.resolve(closed());
			const settling = work();
			running.add(settling);
			void settling.catch(() => {}).finally(() => running.delete(settling));
			return settling;
		},
		network(closed, stopped, signal, work) {
			if (controller.signal.aborted) return Promise.resolve(closed());
			return until(
				work(),
				signal === undefined
					? controller.signal
					: AbortSignal.any([controller.signal, signal]),
				stopped,
			);
		},
		fence: () => controller.abort(),
		close() {
			closing ??= (async () => {
				controller.abort();
				await Promise.allSettled([...running]);
			})();
			return closing;
		},
	};
}

/** The owner's latest snapshot, shared by every view of one attachment. */
type Snapshots = {
	readonly current: GitSnapshot;
	receive(snapshot: GitSnapshot): void;
	subscribe(listener: (snapshot: GitSnapshot) => void): () => void;
	clear(): void;
};

function createSnapshots(initial: GitSnapshot): Snapshots {
	let current = initial;
	const listeners = new Set<(snapshot: GitSnapshot) => void>();
	return {
		get current() {
			return current;
		},
		receive(next) {
			current = next;
			// One subscriber that throws does not keep the owner's snapshot from
			// the others.
			for (const listener of [...listeners])
				if (listeners.has(listener))
					callObserver('history subscriber', listener, current);
		},
		subscribe(listener) {
			listener(current);
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		clear: () => listeners.clear(),
	};
}

const NO_LEASE = () => null;

/**
 * Open the folder the shell registered under `id`, which defaults to the
 * definition's ID. Refusals are returned, not thrown: not running in the
 * shell, a folder this window may not use, a folder another process holds.
 */
export const openFolder: OpenFolder = async ({
	definition,
	id = definition.id,
}) => {
	const compiled = compileFolderDefinition(definition);
	if (compiled.error) return OpenFolderError.InvalidDefinition(compiled.error);
	if (!isTauri()) return OpenFolderError.NotTauri();
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	const scope = id;

	// Listen before attaching, so no event between the attach reply and the
	// first listener is lost. Events at or below the attach sequence are old.
	let history: Snapshots | undefined;
	let sequence = -1;
	const early: { sequence: number; snapshot: WireGitSnapshot }[] = [];
	// The owner announces every change, this window's included.
	const hints = createFileHints();
	const stopListening: (() => void)[] = [];
	const stop = () => {
		for (const unlisten of stopListening) unlisten();
	};
	try {
		stopListening.push(
			await events.folderSnapshotChanged.listen(({ payload }) => {
				if (payload.scope !== scope) return;
				if (history === undefined) {
					early.push(payload);
					return;
				}
				if (payload.sequence <= sequence) return;
				sequence = payload.sequence;
				history.receive(snapshotFromWire(payload.snapshot));
			}),
		);
		stopListening.push(
			await events.folderFilesChanged.listen(({ payload }) => {
				if (payload.scope !== scope) return;
				hints.receive(payload.paths);
			}),
		);
	} catch (cause) {
		stop();
		return OpenFolderError.Unavailable({ cause });
	}
	// The owner refuses a page built for another contract version here, before
	// the page can send it anything that changes the folder.
	const attached = await call(commands.attach(scope, FOLDER_PROTOCOL));
	if (!attached.sent) {
		stop();
		return OpenFolderError.Unavailable({ cause: attached.cause });
	}
	if (attached.settled === 'refused') {
		stop();
		const refusal = attached.error;
		switch (refusal.name) {
			case 'UnknownScope':
				return OpenFolderError.UnknownScope(refusal);
			case 'WindowNotPermitted':
				return OpenFolderError.WindowNotPermitted(refusal);
			case 'Busy':
				return OpenFolderError.Busy(refusal);
			case 'Unavailable':
				return OpenFolderError.Unavailable({ cause: refusal.message });
			case 'ShuttingDown':
				return OpenFolderError.ShuttingDown();
			case 'Incompatible':
				return OpenFolderError.Incompatible(refusal);
			default:
				return OpenFolderError.Unavailable({ cause: refusal });
		}
	}

	const { session, root } = attached.data;
	sequence = attached.data.sequence;
	const snapshots = createSnapshots(snapshotFromWire(attached.data.snapshot));
	history = snapshots;
	for (const event of early.sort((a, b) => a.sequence - b.sequence)) {
		if (event.sequence <= sequence) continue;
		sequence = event.sequence;
		snapshots.receive(snapshotFromWire(event.snapshot));
	}

	const client = createClient();

	/**
	 * Each command holds the folder for its whole run, so no other window's
	 * save lands between its reads and writes; other saves wait, and the owner
	 * ends the hold after 60 seconds. A command still running then fails at
	 * its next file operation.
	 */
	function terminal({ cwd = '/' }: { cwd?: string } = {}): FolderTerminal {
		// The lease this terminal's running command holds, if one is running.
		let held: number | null = null;
		const lease = () => held;
		// The same files and history, with every call naming the held lease so
		// the owner lets it through the gate the lease closed to everyone else.
		const leasedHistory = createHistory(session, snapshots, client, lease);
		const leased = createShellAccess(
			createFolderContext({
				boundary: createBoundary(session, lease),
				history: leasedHistory,
				signal: client.signal,
				landed: () => {},
			}),
			createFolderGit(leasedHistory),
		);
		let shell: FolderTerminal | undefined;
		let tail: Promise<unknown> = Promise.resolve();
		const refused = (reason: string): TerminalResult => ({
			stdout: '',
			stderr: `${reason}\n`,
			exitCode: 1,
		});

		async function run(
			command: string,
			options?: { signal?: AbortSignal },
		): Promise<TerminalResult> {
			// Closing the folder stops a running command at its next step, the
			// same as the caller's own signal, so it cannot carry on with later
			// steps after a wait it was told to stop.
			const signal =
				options?.signal === undefined
					? client.signal
					: AbortSignal.any([client.signal, options.signal]);
			const acquired = await call(commands.acquireLease(session));
			if (!acquired.sent)
				return refused(
					`The folder could not be held for this command: ${describe(acquired.cause)}`,
				);
			if (acquired.settled === 'refused')
				return refused(fileError(acquired.error).message);
			held = acquired.data;
			try {
				shell ??= (await import('./terminal.js')).createFolderTerminal(leased, {
					cwd,
				});
				return await shell.exec(command, { signal });
			} finally {
				// Completed, cancelled, or cut off by the owner's time limit: the
				// folder is given back either way.
				const ended = held;
				held = null;
				await commands.releaseLease(session, ended).catch(() => {});
			}
		}

		return {
			get cwd() {
				return shell?.cwd ?? cwd;
			},
			// One command at a time: a lease belongs to exactly one command. A
			// command is this page's local work: refused once the folder is
			// closing, and waited for by `close` so its lease is released
			// before the session is detached.
			exec(command, options) {
				const running = tail.then(() =>
					client.local(
						() => refused('The folder is closed'),
						() => run(command, options),
					),
				);
				tail = running.catch(() => {});
				return running;
			},
		};
	}

	return Ok(
		assembleFolder<typeof definition>({
			compiled: compiled.data,
			boundary: createBoundary(session, NO_LEASE),
			// Closing the folder fences `client` through this history: Git calls
			// and terminals are refused, and running local ones are waited for,
			// before `release` detaches the session they use.
			history: createHistory(session, snapshots, client, NO_LEASE),
			location: { kind: 'directory', root },
			hints,
			announcePublications: false,
			terminal: (_shell, _signal, options) => terminal(options),
			// Detaches this window only. The owner keeps the folder, finishes what
			// this page saved, and serves every other window.
			release: async () => {
				stop();
				snapshots.clear();
				await commands.detach(session).catch(() => {});
			},
		}),
	);
};
