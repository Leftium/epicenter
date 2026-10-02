/**
 * History coordination for one opened folder (ADR-0468, ADR-0469, ADR-0471).
 *
 * File saves never wait here. A commit captures the whole portable folder,
 * writes blobs and trees, writes a commit on the pinned branch head, and
 * moves the branch with a compare-and-swap. It never reads or writes the
 * shared index to build that commit. A moved branch leaves the candidate
 * unreachable and is reported; there is no retry loop.
 *
 * The backend's exclusive protection is the only thing that orders commits,
 * pulls, and staging, in this handle and across tabs. This module adds no
 * queue of its own for them. With `commitOnEdit`, each save this handle
 * published makes one attempt: it takes that protection only if it is free
 * right now. If it is held, the attempt did not happen and nothing remembers
 * it, so the save can stay uncommitted until a later save or an explicit
 * request. There is no timer and no last commit at close. An explicit request
 * waits for the protection and then reads the folder, so it sees every save
 * that landed while it waited.
 *
 * Pushes and fetches have runners of their own, because network work never
 * runs under the protection. Each push pins the commit it sends. After an
 * automatic commit attempt that ran, a push is attempted if the branch is
 * ahead and no push is running; nothing is owed if it is not. A caller that
 * stops waiting before its push or fetch starts leaves no transport behind.
 * Incoming changes are explicit: `fetch` records the remote head, and
 * `pullFastForward` publishes a clean fast-forward through the file boundary.
 *
 * Status scans take no protection. Callers who ask while a scan is running
 * share the one scan that follows it, so a burst of requests costs two scans
 * and the last one reads the folder after every request was made. That shared
 * scan is the only work here that waits on behalf of several callers, and it
 * never commits or pushes.
 */
import { Ok, type Result } from 'wellcrafted/result';
import type { FileBoundary, FileChange } from '../boundary.js';
import { describe } from '../errors.js';
import { callObserver } from '../observer.js';
import { ancestors, collisionKey, pathProblem } from '../paths.js';
import { hashBytes } from '../capture.js';
import type { GitBackend, GitRemote, PathStatus } from './backend.js';
import { GitError, PullError } from './errors.js';
import { commitSubject, messageProblem, type PathChange } from './messages.js';
import {
	type Author,
	type CommitSummary,
	commitTree,
	countOnly,
	diffFileMaps,
	EMPTY_TREE,
	hashFiles,
	isAncestor,
	readBlob,
	readTreeFiles,
	writeCommitObject,
	writeFilesTree,
} from './objects.js';
import { createPassRunner, type PassRunner } from './runner.js';
import { sourceFiles } from './scope.js';

export { GitError, PullError };

export type CommitOutcome =
	| {
			readonly status: 'committed';
			readonly oid: string;
			readonly parent: string | undefined;
			readonly message: string;
			readonly changedPaths: number;
			/** The branch moved, but the index could not be updated to match. */
			readonly indexWarning: string | undefined;
	  }
	| {
			readonly status: 'unchanged';
			readonly head: string | undefined;
			/** Index entries could not be reset to the head; the next pass retries. */
			readonly indexWarning: string | undefined;
	  }
	| {
			readonly status: 'branchMoved';
			readonly candidate: string;
			readonly expected: string | undefined;
			readonly actual: string | undefined;
	  }
	| { readonly status: 'blocked'; readonly reason: string }
	| { readonly status: 'failed'; readonly error: string }
	/** The host did not acknowledge the operation; inspect history before retrying. */
	| { readonly status: 'unconfirmed'; readonly error: string }
	/** The caller's signal aborted; the pass may still complete. */
	| { readonly status: 'stoppedWaiting' }
	| { readonly status: 'closed' };

export type PushOutcome =
	| { readonly status: 'pushed'; readonly oid: string }
	| { readonly status: 'noRemote' }
	| { readonly status: 'nothingToPush' }
	| { readonly status: 'failed'; readonly oid: string; readonly error: string }
	/** The host did not acknowledge the push; no commit identity is known. */
	| { readonly status: 'unconfirmed'; readonly error: string }
	| { readonly status: 'cancelled'; readonly oid: string | undefined }
	| { readonly status: 'skipped'; readonly reason: string }
	/** The caller's signal aborted; the push may still complete. */
	| { readonly status: 'stoppedWaiting' }
	| { readonly status: 'closed' };

export type FetchOutcome = {
	readonly status: 'fetched';
	/** The remote branch head, or undefined when the remote has no such branch. */
	readonly oid: string | undefined;
};

export type PullOutcome =
	| { readonly status: 'upToDate'; readonly head: string | undefined }
	| { readonly status: 'ahead'; readonly head: string }
	| {
			readonly status: 'fastForwarded';
			readonly from: string | undefined;
			readonly to: string;
			readonly changedPaths: readonly string[];
	  };

export type Observation<T> =
	| { readonly state: 'unknown'; readonly error: string | undefined }
	| {
			readonly state: 'observed';
			readonly value: T;
			readonly checkedAt: number;
			/** A known change happened after this observation was captured. */
			readonly stale: boolean;
			/** The latest attempt to refresh failed; `value` is the prior observation. */
			readonly error: string | undefined;
	  };

export type FilesObservation = {
	readonly head: string | undefined;
	/** Portable files that differ from the committed tree. */
	readonly changes: readonly PathChange[];
};

export type SyncObservation = {
	readonly head: string | undefined;
	/** The remote branch head as last recorded by a fetch or push. */
	readonly remote: string | undefined;
	readonly ahead: number;
	readonly behind: number;
};

export type Activity = { readonly active: boolean };

export type Attempt<T> = T & { readonly at: number };

export type GitSnapshot = {
	readonly branch: string;
	readonly remote: GitRemote | undefined;
	readonly commitOnEdit: boolean;
	readonly files: Observation<FilesObservation>;
	readonly sync: Observation<SyncObservation>;
	readonly activity: {
		readonly scan: Activity;
		readonly commit: Activity;
		readonly push: Activity;
		readonly fetch: Activity;
		readonly pull: Activity;
	};
	readonly lastCommit: Attempt<CommitOutcome> | undefined;
	readonly lastPush: Attempt<PushOutcome> | undefined;
	readonly lastFetch:
		| Attempt<{ readonly result: Result<FetchOutcome, GitError> }>
		| undefined;
	readonly lastPull:
		| Attempt<{ readonly result: Result<PullOutcome, PullError | GitError> }>
		| undefined;
	readonly closed: boolean;
};

export type CommitAndPushResult = {
	readonly commit: CommitOutcome;
	readonly push: PushOutcome;
};

export type History = ReturnType<typeof createHistory>;

export function createHistory({
	backend,
	boundary,
	author,
	commitOnEdit,
	landed = () => {},
}: {
	backend: GitBackend;
	boundary: FileBoundary;
	author: Author;
	commitOnEdit: boolean;
	/** Paths an incoming update wrote or removed, whether or not it completed. */
	landed?: (paths: readonly string[]) => void;
}) {
	let clock = 0;
	let lastEdit = 0;
	/**
	 * Aborted when closing starts. From then on nothing new is admitted, and a
	 * request still waiting for the backend's protection is refused instead of
	 * running after the folder closed. Work already inside the protection is
	 * not interrupted.
	 */
	const closing = new AbortController();
	/** Commits and pulls of this handle that are waiting or running. */
	const running = { commit: 0, pull: 0 };
	/** The backend's protection, waited for unless closing gets there first. */
	const exclusive = <T>(work: () => Promise<T>) =>
		backend.exclusive(work, closing.signal);
	let closed: Promise<void> | undefined;
	let files: Observation<FilesObservation> & { capturedAt?: number } = {
		state: 'unknown',
		error: undefined,
	};
	let sync: Observation<SyncObservation> = {
		state: 'unknown',
		error: undefined,
	};
	let lastCommit: GitSnapshot['lastCommit'];
	let lastPush: GitSnapshot['lastPush'];
	let lastFetch: GitSnapshot['lastFetch'];
	let lastPull: GitSnapshot['lastPull'];
	let remoteSeq = 0;
	/** Git work of this handle, other than runner passes, that close waits for. */
	const admittedWork = new Set<Promise<unknown>>();
	const listeners = new Set<(snapshot: GitSnapshot) => void>();
	let snapshot: GitSnapshot;

	function activity(runner: { active: boolean }): Activity {
		return { active: runner.active };
	}

	function emit() {
		const { capturedAt: _capturedAt, ...publicFiles } =
			files as typeof files & {
				capturedAt?: number;
			};
		snapshot = Object.freeze({
			branch: backend.branch,
			remote: backend.remote,
			commitOnEdit,
			files: publicFiles as Observation<FilesObservation>,
			sync,
			activity: {
				scan: activity(scanRunner),
				commit: { active: running.commit > 0 },
				push: activity(pushRunner),
				fetch: activity(fetchRunner),
				pull: { active: running.pull > 0 },
			},
			lastCommit,
			lastPush,
			lastFetch,
			lastPull,
			closed: closing.signal.aborted,
		});
		// A snapshot is published from inside saves and passes. A subscriber
		// that throws must not fail the save that changed the snapshot.
		for (const listener of [...listeners])
			if (listeners.has(listener))
				callObserver('history subscriber', listener, snapshot);
	}

	/** Record files observed at `capturedAt` unless a newer observation exists. */
	function observeFiles(capturedAt: number, value: FilesObservation) {
		if (files.state === 'observed' && (files.capturedAt ?? 0) > capturedAt)
			return;
		files = {
			state: 'observed',
			value,
			checkedAt: Date.now(),
			stale: lastEdit > capturedAt,
			error: undefined,
			capturedAt,
		};
	}

	function failFiles(error: string) {
		files =
			files.state === 'observed'
				? { ...files, stale: true, error }
				: { state: 'unknown', error };
	}

	async function headFiles(head: string | undefined) {
		if (head === undefined)
			return new Map<string, { oid: string; mode: string }>();
		return backend.withObjects(async (access) =>
			readTreeFiles(access, await commitTree(access, head)),
		);
	}

	async function refreshSync() {
		try {
			const [head, remote] = await Promise.all([
				backend.readBranch(),
				backend.readRemoteTracking(),
			]);
			const [ahead, behind] = await backend.withObjects((access) =>
				Promise.all([
					countOnly(access, head, remote),
					countOnly(access, remote, head),
				]),
			);
			sync = {
				state: 'observed',
				value: { head, remote, ahead, behind },
				checkedAt: Date.now(),
				stale: false,
				error: undefined,
			};
		} catch (cause) {
			const error = describe(cause);
			sync =
				sync.state === 'observed'
					? { ...sync, stale: true, error }
					: { state: 'unknown', error };
		}
	}

	async function capture() {
		const captured = await boundary.capture();
		if (captured.error) throw new Error(captured.error.message);
		if (captured.data.unreadable.length > 0)
			throw new Error(
				`${captured.data.unreadable.length} files could not be read: ${captured.data.unreadable
					.map((item) => item.path)
					.join(', ')}`,
			);
		return captured.data.files;
	}

	/** Captured files that are history source under the shared scope rule. */
	function source(
		current: ReadonlyMap<string, Uint8Array>,
		tracked: ReadonlyMap<string, unknown>,
	) {
		return sourceFiles(current, tracked, backend.ignoredPaths);
	}

	/**
	 * Record a clean observation only if the branch still names `head`;
	 * otherwise invalidate and start a real scan if none is running. The branch
	 * already moved when this runs, so a branch that cannot be read back is an
	 * observation failure, never a reason to report the commit as failed.
	 */
	async function observeCommitted(
		capturedAt: number,
		head: string | undefined,
	) {
		let actual: string | undefined;
		try {
			actual = await backend.readBranch();
		} catch (cause) {
			failFiles(describe(cause));
			return;
		}
		if (actual === head) {
			observeFiles(capturedAt, { head, changes: [] });
			return;
		}
		if (files.state === 'observed') files = { ...files, stale: true };
		void scanRunner.attempt();
	}

	/** A known file change: existing observations become stale. */
	function markEdited() {
		lastEdit = ++clock;
		if (files.state === 'observed' && !files.stale)
			files = { ...files, stale: true };
	}

	/**
	 * An operation failed after some of its file changes landed. The cached
	 * clean observation no longer describes the folder: mark it stale and
	 * start a fresh scan if none is running. This requests no commit.
	 */
	function markLanded() {
		markEdited();
		void scanRunner.attempt();
	}

	const scanRunner = createPassRunner<void, Result<FilesObservation, GitError>>(
		{
			async run() {
				const capturedAt = ++clock;
				try {
					const captured = await capture();
					const head = await backend.readBranch();
					const committed = await headFiles(head);
					const hashes = await hashFiles(await source(captured, committed));
					const value: FilesObservation = {
						head,
						changes: diffFileMaps(committed, hashes),
					};
					observeFiles(capturedAt, value);
					await refreshSync();
					emit();
					return Ok(value);
				} catch (cause) {
					failFiles(describe(cause));
					emit();
					return GitError.Failed({ operation: 'status', cause });
				}
			},
			failed: (cause) => GitError.Failed({ operation: 'status', cause }),
			closed: () => GitError.Closed(),
			onChange: () => emit(),
		},
	);

	/** Why this folder's history cannot take a whole-folder commit or update now. */
	async function wholeFolderProblem(): Promise<string | undefined> {
		return (await backend.blocked()) ?? (await backend.checkpointProblem());
	}

	/**
	 * One whole-folder commit under the backend's protection. `admit` is how
	 * that protection is entered: waiting for it, or only if it is free.
	 */
	async function checkpoint<TAdmitted>(
		admit: (work: () => Promise<CommitOutcome>) => Promise<TAdmitted>,
	): Promise<TAdmitted> {
		return admit(async () => {
			if (closing.signal.aborted) return { status: 'closed' };
			const blocked = await wholeFolderProblem();
			if (blocked !== undefined) return { status: 'blocked', reason: blocked };
			// Pin the parent, then capture, both inside the Git lock. A pull or
			// staged commit that changed files and the branch while this pass
			// waited is part of the capture, so an older capture can never be
			// committed on top of a newer parent. An external branch move after
			// this point still fails the compare-and-swap below.
			const parent = await backend.readBranch();
			const capturedAt = ++clock;
			const current = await capture();
			const committed = await headFiles(parent);
			const included = await source(current, committed);
			const built = await backend.withObjects(async (access) => {
				const tree = await writeFilesTree(access, included);
				const parentTree =
					parent === undefined ? EMPTY_TREE : await commitTree(access, parent);
				if (tree === parentTree) return undefined;
				const changes = diffFileMaps(
					committed,
					await readTreeFiles(access, tree),
				);
				const message = commitSubject(changes);
				if (message === undefined) return undefined;
				const oid = await writeCommitObject(access, {
					tree,
					parents: parent === undefined ? [] : [parent],
					message,
					author,
				});
				return { oid, message, changes };
			});
			if (built !== undefined) {
				const moved = await backend.casBranch(parent, built.oid);
				if (!moved.ok)
					return {
						status: 'branchMoved',
						candidate: built.oid,
						expected: parent,
						actual: moved.actual,
					};
			}
			const head = built?.oid ?? parent;
			// A whole-folder checkpoint supersedes staged-only intent: every index
			// entry, including staged-only additions and deletions, is reset to
			// the head. This also repairs staging when nothing new was committed.
			let indexWarning: string | undefined;
			if (head !== undefined)
				try {
					await backend.reconcileIndex(head);
				} catch (cause) {
					indexWarning = describe(cause);
				}
			await observeCommitted(capturedAt, head);
			if (built === undefined)
				return { status: 'unchanged', head: parent, indexWarning };
			return {
				status: 'committed',
				oid: built.oid,
				parent,
				message: built.message,
				changedPaths: built.changes.length,
				indexWarning,
			};
		});
	}

	/**
	 * Run one commit or pull of this handle. It counts as active from the
	 * moment it is asked for, including any wait for the backend's protection,
	 * and `close()` waits for it. `work` must not reject.
	 */
	function owned<T>(kind: 'commit' | 'pull', work: () => Promise<T>) {
		running[kind]++;
		const completion = Promise.withResolvers<T>();
		const settled = completion.promise.finally(() => {
			running[kind]--;
			admittedWork.delete(settled);
			emit();
		});
		admittedWork.add(settled);
		// Register before work or observers can synchronously close this handle.
		try {
			void work().then(completion.resolve, completion.reject);
		} catch (cause) {
			completion.reject(cause);
		}
		emit();
		return settled;
	}

	/** Whether `cause` is closing refusing a request that was still waiting. */
	const refusedByClose = (cause: unknown) =>
		closing.signal.aborted && cause === closing.signal.reason;

	const failedCommit = (cause: unknown): CommitOutcome => ({
		status: 'failed',
		error: describe(cause),
	});

	/** Record what a commit that ran did and what is now known of the remote. */
	async function settleCommit(outcome: CommitOutcome) {
		lastCommit = { ...outcome, at: Date.now() };
		await refreshSync();
		emit();
	}

	/**
	 * An explicit commit. It waits for the backend's protection and captures
	 * inside it. Closing refuses it while it still waits; once inside, it runs
	 * to its end and reports what it did.
	 */
	function commitNow(): Promise<CommitOutcome> {
		if (closing.signal.aborted) return Promise.resolve({ status: 'closed' });
		return owned('commit', async (): Promise<CommitOutcome> => {
			let outcome: CommitOutcome;
			try {
				outcome = await checkpoint((work) => exclusive(work));
			} catch (cause) {
				// Refused while waiting: nothing ran, so no attempt is recorded.
				if (refusedByClose(cause)) return { status: 'closed' };
				outcome = failedCommit(cause);
			}
			if (outcome.status === 'closed') return outcome;
			await settleCommit(outcome);
			return outcome;
		});
	}

	/**
	 * The one attempt a save makes. It enters the backend's protection only
	 * if nothing holds it now: another tab, a pull, a staged command, or an
	 * earlier commit. Held, the attempt did not happen: no outcome is
	 * recorded, nothing is pushed, and nothing runs when it is released.
	 */
	function commitIfFree() {
		void owned('commit', async () => {
			const attempt = await checkpoint((work) =>
				backend.tryExclusive(work),
			).catch((cause) => ({ ran: true as const, value: failedCommit(cause) }));
			if (!attempt.ran || attempt.value.status === 'closed') return;
			await settleCommit(attempt.value);
			// A push that cannot start now is not owed later.
			const ahead =
				sync.state === 'observed' && !sync.stale && sync.value.ahead > 0;
			if (backend.remote !== undefined && ahead) void pushRunner.attempt();
		});
	}

	const pushRunner = createPassRunner<void, PushOutcome>({
		async run(_input, signal) {
			if (backend.remote === undefined) return { status: 'noRemote' };
			const oid = await backend.readBranch();
			if (oid === undefined) return { status: 'nothingToPush' };
			const sequence = ++remoteSeq;
			let outcome: PushOutcome;
			try {
				await backend.push(oid, signal);
				outcome = { status: 'pushed', oid };
			} catch (cause) {
				outcome = signal.aborted
					? { status: 'cancelled', oid }
					: { status: 'failed', oid, error: describe(cause) };
			}
			// A push that started before a newer fetch or push must not replace its observation.
			if (sequence === remoteSeq) await refreshSync();
			lastPush = { ...outcome, at: Date.now() };
			emit();
			return outcome;
		},
		failed: (cause) => ({ status: 'failed', oid: '', error: describe(cause) }),
		closed: () => ({ status: 'closed' }),
		onChange: () => emit(),
	});

	const fetchRunner = createPassRunner<void, Result<FetchOutcome, GitError>>({
		async run(_input, signal) {
			if (backend.remote === undefined) return GitError.NoRemote();
			const sequence = ++remoteSeq;
			let result: Result<FetchOutcome, GitError>;
			try {
				result = Ok({ status: 'fetched', oid: await backend.fetch(signal) });
			} catch (cause) {
				result = GitError.Failed({ operation: 'fetch', cause });
			}
			if (sequence === remoteSeq) await refreshSync();
			lastFetch = { result, at: Date.now() };
			emit();
			return result;
		},
		failed: (cause) => GitError.Failed({ operation: 'fetch', cause }),
		closed: () => GitError.Closed(),
		onChange: () => emit(),
	});

	async function pull(): Promise<Result<PullOutcome, PullError | GitError>> {
		if (backend.remote === undefined) return GitError.NoRemote();
		return exclusive(async () => {
			const blocked = await wholeFolderProblem();
			if (blocked !== undefined) return PullError.Blocked({ reason: blocked });
			const capturedAt = ++clock;
			const fetched = await backend.readRemoteTracking();
			if (fetched === undefined) return PullError.NoFetchedHead();
			const head = await backend.readBranch();
			if (head === fetched) return Ok({ status: 'upToDate', head });
			if (head !== undefined) {
				const fastForward = await backend.withObjects((access) =>
					isAncestor(access, head, fetched),
				);
				if (!fastForward) {
					const contained = await backend.withObjects((access) =>
						isAncestor(access, fetched, head),
					);
					if (contained) return Ok({ status: 'ahead', head });
					return PullError.Diverged({ head, fetched });
				}
			}
			// The entire folder must be clean, including staged changes.
			const raw = await capture();
			const committed = await headFiles(head);
			const current = await source(raw, committed);
			const dirty = diffFileMaps(committed, await hashFiles(current));
			if (dirty.length > 0)
				return PullError.Dirty({ paths: dirty.map((change) => change.path) });
			if (!(await backend.indexMatchesHead())) return PullError.StagedChanges();

			const incoming = await headFiles(fetched);
			const unsupported = [...incoming]
				.filter(([, entry]) => entry.mode !== '100644')
				.map(([path]) => path);
			if (unsupported.length > 0)
				return PullError.Unrepresentable({
					paths: unsupported,
					reason:
						'symbolic links, submodules, and executable files are not plain folder files',
				});
			const invalid = [...incoming.keys()].filter(
				(path) => pathProblem(path) !== undefined,
			);
			if (invalid.length > 0)
				return PullError.Unrepresentable({
					paths: invalid,
					reason: 'some paths are not valid folder paths',
				});
			// The fast-forward writes each blob's bytes as they are stored. A
			// commit that declares a filter or a conversion for a path means
			// something else by those bytes: under `filter=lfs` the blob is a
			// pointer, not the audio. Every incoming path is asked about, against
			// the fetched commit's own attributes, so a commit that only adds an
			// attribute over a file it does not touch is refused as well.
			const declared = await backend.incomingAttribute(fetched, incoming);
			if (declared !== undefined)
				return PullError.Unrepresentable({
					paths: [declared.path],
					reason: `the incoming commit declares the Git attribute ${declared.attribute}, and this folder does not apply attribute filters or conversion`,
				});
			const folded = new Map<string, string>();
			for (const path of incoming.keys()) {
				const key = collisionKey(path);
				const existing = folded.get(key);
				if (existing !== undefined)
					return PullError.Unrepresentable({
						paths: [existing, path],
						reason: 'paths collide on case-insensitive filesystems',
					});
				folded.set(key, path);
			}

			const changes = diffFileMaps(committed, incoming);
			// Ignored and untracked files are preserved, never overwritten.
			const rawPaths = [...raw.keys()];
			const colliding = changes
				.filter((change) => change.kind === 'add')
				.map((change) => change.path)
				.filter(
					(path) =>
						raw.has(path) ||
						ancestors(path).some((parent) => raw.has(parent)) ||
						rawPaths.some((existing) => existing.startsWith(`${path}/`)),
				);
			if (colliding.length > 0)
				return PullError.Collision({ paths: colliding });
			const removals: FileChange[] = [];
			const writes: FileChange[] = [];
			for (const change of changes) {
				const bytes = current.get(change.path);
				if (change.kind === 'delete') {
					if (bytes === undefined)
						return PullError.Dirty({ paths: [change.path] });
					removals.push({
						kind: 'remove',
						path: change.path,
						expectedSha256: await hashBytes(bytes),
					});
					continue;
				}
				const next = await backend.withObjects((access) =>
					readBlob(access, incoming.get(change.path)!.oid),
				);
				const write = {
					path: change.path,
					bytes: next,
					sha256: await hashBytes(next),
				};
				writes.push(
					bytes === undefined
						? { kind: 'create', ...write }
						: {
								kind: 'replace',
								...write,
								expectedSha256: await hashBytes(bytes),
							},
				);
			}
			const changedPaths = changes.map((change) => change.path);
			const published = await backend.publishFastForward({
				expectedHead: head,
				nextHead: fetched,
				changes: [...removals, ...writes],
				paths: changedPaths,
			});
			switch (published.status) {
				case 'published':
					await observeCommitted(capturedAt, fetched);
					landed(changedPaths);
					return Ok({
						status: 'fastForwarded',
						from: head,
						to: fetched,
						changedPaths,
					});
				case 'refused':
					return PullError.Refused({ error: published.error });
				case 'partial':
					markLanded();
					landed(
						published.applied.flatMap((step) =>
							step.kind === 'move' ? [step.from, step.to] : [step.path],
						),
					);
					return PullError.Partial({
						applied: published.applied,
						error: published.error,
					});
				case 'branchMoved':
					if (published.filesApplied) {
						markLanded();
						landed(changedPaths);
					}
					return PullError.BranchMoved({
						actual: published.actual,
						filesApplied: published.filesApplied,
					});
				case 'indexFailed':
					markLanded();
					landed(changedPaths);
					return PullError.IndexFailed({ error: published.error });
			}
		});
	}

	/** An explicit pull. Closing refuses it while it still waits for the protection. */
	function pullNow(): Promise<Result<PullOutcome, PullError | GitError>> {
		if (closing.signal.aborted) return Promise.resolve(GitError.Closed());
		return owned('pull', async () => {
			let result: Result<PullOutcome, PullError | GitError>;
			try {
				result = await pull();
			} catch (cause) {
				if (refusedByClose(cause)) return GitError.Closed();
				result = GitError.Failed({ operation: 'pull', cause });
			}
			if (result.error === null || result.error.name !== 'Failed')
				await refreshSync();
			lastPull = { result, at: Date.now() };
			emit();
			return result;
		});
	}

	/**
	 * Stop this caller waiting when its signal aborts. A caller signal never
	 * aborts the transport; only closing the folder does.
	 */
	function until<T>(
		promise: Promise<T>,
		signal: AbortSignal | undefined,
		stopped: () => T,
	) {
		if (signal === undefined) return promise;
		if (signal.aborted) return Promise.resolve(stopped());
		return new Promise<T>((resolve) => {
			const abort = () => resolve(stopped());
			signal.addEventListener('abort', abort, { once: true });
			promise.then((value) => {
				signal.removeEventListener('abort', abort);
				resolve(value);
			});
		});
	}

	const stoppedPush = (): PushOutcome => ({ status: 'stoppedWaiting' });

	/**
	 * One push or fetch for a caller that may stop waiting. A caller who has
	 * left when the pass's turn comes starts no transport. One who leaves after
	 * the transport started is told so while it carries on.
	 */
	function network<T>(
		runner: PassRunner<void, T>,
		signal: AbortSignal | undefined,
		stopped: () => T,
	) {
		if (signal === undefined) return runner.request();
		return until(
			runner.request(undefined, { signal, withdrawn: stopped }),
			signal,
			stopped,
		);
	}

	/**
	 * Admit one explicit Git operation for its whole lifetime, including any
	 * refresh after the backend call. Refused once closing starts; `close()`
	 * drains admitted work before storage is released.
	 */
	function manual<T>(
		operation: string,
		work: () => Promise<Result<T, GitError>>,
	): Promise<Result<T, GitError>> {
		if (closing.signal.aborted) return Promise.resolve(GitError.Closed());
		const settled = work().catch((cause) =>
			refusedByClose(cause)
				? GitError.Closed()
				: GitError.Failed({ operation, cause }),
		);
		admittedWork.add(settled);
		void settled.then(() => admittedWork.delete(settled));
		return settled;
	}

	function guarded<T>(
		operation: string,
		work: () => Promise<T>,
	): Promise<Result<T, GitError>> {
		return manual(operation, async () => Ok(await work()));
	}

	async function commitStaged(
		message: string,
	): Promise<Result<{ oid: string; parent: string | undefined }, GitError>> {
		const problem = messageProblem(message);
		if (problem !== undefined)
			return GitError.InvalidMessage({ reason: problem });
		const blocked = await backend.blocked();
		if (blocked !== undefined)
			return GitError.Failed({ operation: 'commit', cause: blocked });
		let changedPaths = 0;
		let result: Awaited<ReturnType<GitBackend['commitIndex']>>;
		try {
			result = await exclusive(async () => {
				changedPaths = (await backend.pathStatus()).filter(
					(path) => path.index !== ' ' && path.index !== '?',
				).length;
				return backend.commitIndex(message, author);
			});
		} catch (cause) {
			if (refusedByClose(cause)) return GitError.Closed();
			return GitError.Failed({ operation: 'commit', cause });
		}
		if (result.status === 'committed') {
			lastCommit = {
				...result,
				message,
				changedPaths,
				indexWarning: undefined,
				at: Date.now(),
			};
		}
		await refreshSync();
		if (files.state === 'observed') files = { ...files, stale: true };
		emit();
		switch (result.status) {
			case 'nothing':
				return GitError.NothingToCommit();
			case 'branchMoved':
				return GitError.BranchMoved({
					expected: undefined,
					actual: result.actual,
				});
			case 'committed':
				return Ok({ oid: result.oid, parent: result.parent });
		}
	}

	/**
	 * Synchronously: refuse every new request, refuse the ones still waiting
	 * for the backend's protection, and abort the active push and fetch. Work
	 * already inside the protection finishes on its own.
	 */
	let runners: Promise<unknown> | undefined;
	function beginClose() {
		if (closing.signal.aborted) return;
		closing.abort(new Error('The folder is closed'));
		runners = Promise.all([
			pushRunner.close(),
			fetchRunner.close(),
			scanRunner.close(),
		]);
		emit();
	}

	emit();

	return {
		get snapshot() {
			return snapshot;
		},
		subscribe(listener: (snapshot: GitSnapshot) => void): () => void {
			listener(snapshot);
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** A known file change: existing observations become stale. */
		noteEdit() {
			const wasFresh = files.state === 'observed' && !files.stale;
			markEdited();
			if (wasFresh) emit();
		},
		/**
		 * The one attempt after a save this handle published; never awaited by
		 * the save. It commits only if the backend's protection is free now.
		 */
		requestAutomaticCommit() {
			if (!commitOnEdit || closing.signal.aborted) return;
			commitIfFree();
		},
		status: (): Promise<Result<FilesObservation, GitError>> =>
			scanRunner.follow(),
		/** Commits the folder's current files without pushing. */
		commit: commitNow,
		async commitAndPush({
			signal,
		}: {
			signal?: AbortSignal;
		} = {}): Promise<CommitAndPushResult> {
			const commit = await until(
				commitNow(),
				signal,
				(): CommitOutcome => ({ status: 'stoppedWaiting' }),
			);
			if (commit.status !== 'committed' && commit.status !== 'unchanged')
				return {
					commit,
					push:
						commit.status === 'stoppedWaiting'
							? { status: 'stoppedWaiting' }
							: { status: 'skipped', reason: 'the commit did not complete' },
				};
			if (backend.remote === undefined)
				return { commit, push: { status: 'noRemote' } };
			// The push is this caller's next step, not the commit's. A caller
			// that stopped waiting starts none; the commit it left still finishes.
			const push = await network(pushRunner, signal, stoppedPush);
			return { commit, push };
		},
		push: ({ signal }: { signal?: AbortSignal } = {}): Promise<PushOutcome> =>
			network(pushRunner, signal, stoppedPush),
		fetch: ({
			signal,
		}: {
			signal?: AbortSignal;
		} = {}): Promise<Result<FetchOutcome, GitError>> =>
			network(fetchRunner, signal, () =>
				GitError.StoppedWaiting({ operation: 'fetch' }),
			),
		pullFastForward: pullNow,
		paths: (): Promise<Result<PathStatus[], GitError>> =>
			guarded('status', () => exclusive(() => backend.pathStatus())),
		async stage(
			paths: readonly string[] | 'all',
		): Promise<Result<undefined, GitError>> {
			if (closing.signal.aborted) return GitError.Closed();
			if (commitOnEdit) return GitError.AutomaticHistory();
			const result = await guarded('add', () =>
				exclusive(() => backend.stage(paths)),
			);
			if (result.error === null) return Ok(undefined);
			return result;
		},
		commitStaged(
			message: string,
		): Promise<Result<{ oid: string; parent: string | undefined }, GitError>> {
			if (closing.signal.aborted) return Promise.resolve(GitError.Closed());
			if (commitOnEdit) return Promise.resolve(GitError.AutomaticHistory());
			return manual('commit', () => commitStaged(message));
		},
		diff: (options: { staged: boolean; paths: readonly string[] }) =>
			guarded('diff', () => exclusive(() => backend.diff(options))),
		log: (depth: number): Promise<Result<CommitSummary[], GitError>> =>
			guarded('log', () => backend.log(depth)),
		beginClose,
		/**
		 * Resolve once nothing of this handle still uses storage: the commits,
		 * pulls, and other Git operations already inside the backend's
		 * protection finished, and the aborted network work returned. There is
		 * no last commit: a save whose attempt was skipped or failed is still
		 * uncommitted when this resolves.
		 */
		close(): Promise<void> {
			closed ??= (async () => {
				beginClose();
				await Promise.all([runners, Promise.allSettled([...admittedWork])]);
				emit();
			})();
			return closed;
		},
	};
}
