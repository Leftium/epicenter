/**
 * Borrowed folder access whose files live in another process.
 *
 * Every folder method takes data and answers with data, so the client forwards
 * each call as its path and arguments and returns the host's `Result`
 * unchanged. The host runs tables, KV, conditional publication, and history
 * beside the real files; nothing is cached or mirrored here. The one piece of
 * local state is the latest Git snapshot, which the host pushes so
 * `git.snapshot` and `git.subscribe` stay synchronous.
 *
 * Nothing here is specific to Whispering.
 */

import type { DataDefinition } from '@epicenter/definition';
import {
	BatchError,
	type FileCapture,
	FileError,
	type FolderAccess,
	type FolderBatch,
	type FolderFiles,
	type FolderGit,
	GitError,
	type GitSnapshot,
} from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	BatchContent,
	BatchPlan,
	BatchRowInput,
	BatchStep,
} from './batch-plan.js';

export type BridgeEvent =
	| { readonly type: 'git'; readonly snapshot: GitSnapshot }
	| { readonly type: 'files' }
	/** The host's owner wants to close and asks whether the page may be dropped. */
	| { readonly type: 'close-requested' }
	| { readonly type: 'ping' };

export type FolderTransport = {
	/** Rejects only when the host cannot be reached or refuses the call. */
	call(path: readonly string[], args: readonly unknown[]): Promise<unknown>;
	/** Delivers host events until `signal` aborts; resolves when the stream ends. */
	events(
		onEvent: (event: BridgeEvent) => void,
		signal: AbortSignal,
	): Promise<void>;
};

export type RemoteFolder<TDefinition extends DataDefinition> = {
	readonly folder: FolderAccess<TDefinition>;
	/** Files changed outside this page: another program, the terminal, or Git. */
	onExternalChange(listener: () => void): () => void;
	/** The host's owner asks to close; the page answers through its own channel. */
	onCloseRequested(listener: () => void): () => void;
	/** Whether the event stream is currently connected. */
	readonly connected: boolean;
	onConnection(listener: (connected: boolean) => void): () => void;
	/** Fence calls, end events, and settle this client's admitted calls. */
	close(): Promise<void>;
};

const TABLE_METHODS = [
	'list',
	'get',
	'create',
	'update',
	'writeSource',
	'rename',
	'delete',
] as const;
const KV_METHODS = ['get', 'update', 'writeSource'] as const;
const FILE_METHODS = [
	'list',
	'children',
	'read',
	'create',
	'replace',
	'remove',
	'move',
	'overwrite',
	'mkdir',
	'rmdir',
] as const;
const GIT_RESULT_METHODS = [
	'status',
	'pullFastForward',
	'paths',
	'stage',
	'commitStaged',
	'diff',
	'log',
] as const;

const RECONNECT_MS = 500;

/**
 * A detached copy of what a caller passed, taken synchronously at the call.
 *
 * The folder fixes a save's bytes, its captured baseline, and a row's values
 * when the method is called. A bridged call is sent a moment later, so
 * without this the caller could reuse its array or change its capture or
 * fields in between and a different save would be sent. Bytes are copied
 * once, here; the wire encoding reads this copy and makes no second one.
 *
 * Only shape is copied. A value of the wrong shape is passed on as it is, so
 * the folder refuses it with its own answer.
 */
function detach<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Uint8Array) return new Uint8Array(value) as T;
	if (value instanceof ArrayBuffer) return value.slice(0) as T;
	if (Array.isArray(value)) return value.map(detach) as T;
	if (value instanceof Map)
		return new Map(
			[...value].map(([key, item]) => [detach(key), detach(item)]),
		) as T;
	if (value instanceof Set) return new Set([...value].map(detach)) as T;
	// An error, a Blob, or another class instance is the wire encoding's to judge.
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) copy[key] = detach(item);
	return copy as T;
}

/**
 * Run a batch callback once, synchronously, against a recorder that writes
 * down the mutations it names. The host names the same mutations on the real
 * folder's batch, which is what validates and publishes them. A callback that
 * throws or returns anything publishes nothing, with the folder's own
 * refusals, and the recorder stops accepting calls when the callback returns.
 */
function recordBatch<TDefinition extends DataDefinition>(
	tableNames: readonly string[],
	collect: (batch: FolderBatch<TDefinition>) => undefined,
): Result<BatchPlan, BatchError> {
	const steps: BatchStep[] = [];
	let sealed = false;
	function add(step: BatchStep) {
		if (sealed)
			throw new Error(
				'This batch is sealed. A batch collects mutations only while its callback runs; it cannot be kept or used after an await.',
			);
		steps.push(step);
	}

	const tables: Record<string, unknown> = {};
	for (const table of tableNames)
		tables[table] = Object.freeze({
			// The row's stem, values, and body are fixed here, when it is named.
			create: (input: BatchRowInput) =>
				add({ op: 'tables.create', table, input: detach({ ...input }) }),
		});
	// Each mutation's bytes and captured baseline are fixed when it is named.
	const recorder = Object.freeze({
		files: Object.freeze({
			create: (path: string, content: BatchContent) =>
				add({ op: 'files.create', path, content: detach(content) }),
			replace: (file: FileCapture, content: BatchContent) =>
				add({
					op: 'files.replace',
					file: detach(file),
					content: detach(content),
				}),
			remove: (file: FileCapture) =>
				add({ op: 'files.remove', file: detach(file) }),
			move: (file: FileCapture, destination: string) =>
				add({ op: 'files.move', file: detach(file), destination }),
			overwrite: (path: string, content: BatchContent) =>
				add({ op: 'files.overwrite', path, content: detach(content) }),
		}),
		tables: Object.freeze(tables),
	}) as unknown as FolderBatch<TDefinition>;

	let returned: unknown;
	try {
		returned = (collect as (batch: FolderBatch<TDefinition>) => unknown)(
			recorder,
		);
	} catch (cause) {
		return BatchError.Threw({ cause });
	} finally {
		sealed = true;
	}
	if (returned !== undefined) {
		const thenable =
			typeof (returned as { then?: unknown } | null)?.then === 'function';
		// The promise is not waited for; its later failure is already reported here.
		if (thenable) void Promise.resolve(returned).catch(() => {});
		return BatchError.Returned({ thenable });
	}
	return Ok(steps);
}

export async function connectFolder<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	transport: FolderTransport,
): Promise<RemoteFolder<TDefinition>> {
	const controller = new AbortController();
	const snapshotListeners = new Set<(snapshot: GitSnapshot) => void>();
	const changeListeners = new Set<() => void>();
	const closeListeners = new Set<() => void>();
	const connectionListeners = new Set<(connected: boolean) => void>();
	let connected = false;
	const inFlight = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;

	function call(path: readonly string[], args: readonly unknown[]) {
		if (controller.signal.aborted)
			return Promise.reject(new Error('The folder client is closed'));
		const running = Promise.resolve().then(() => transport.call(path, args));
		inFlight.add(running);
		void running.catch(() => {}).finally(() => inFlight.delete(running));
		return running;
	}

	/** Stop one caller waiting; the host still owns the shared operation. */
	function until<T>(
		running: Promise<T>,
		signal: AbortSignal | undefined,
		stopped: () => T,
	): Promise<T> {
		if (signal === undefined) return running;
		if (signal.aborted) return Promise.resolve(stopped());
		return new Promise((resolve, reject) => {
			const stop = () => resolve(stopped());
			signal.addEventListener('abort', stop, { once: true });
			void running
				.then(resolve, reject)
				.finally(() => signal.removeEventListener('abort', stop));
		});
	}

	/** An unacknowledged mutation may have completed at the host. */
	async function fileCall<T>(
		path: readonly string[],
		args: readonly unknown[],
	): Promise<T> {
		if (controller.signal.aborted) return FileError.Closed() as T;
		try {
			return (await call(path, args)) as T;
		} catch (cause) {
			const method = path.at(-1)!;
			const failure = ['list', 'children', 'get', 'read', 'open'].includes(
				method,
			)
				? FileError.Io
				: FileError.Unconfirmed;
			return failure({ path: path.join('.'), operation: method, cause }) as T;
		}
	}

	async function gitCall<T>(method: string, args: readonly unknown[]) {
		if (controller.signal.aborted) return GitError.Closed() as T;
		try {
			return (await call(['git', method], args)) as T;
		} catch (cause) {
			return (
				['status', 'paths', 'diff', 'log'].includes(method)
					? GitError.Failed({ operation: method, cause })
					: GitError.Unconfirmed({ operation: method, cause })
			) as T;
		}
	}

	let snapshot = (await call(['git', 'snapshot'], [])) as GitSnapshot;

	function setSnapshot(next: GitSnapshot) {
		if (controller.signal.aborted) return;
		snapshot = next;
		for (const listener of snapshotListeners) listener(next);
	}

	function setConnected(next: boolean) {
		if (connected === next) return;
		connected = next;
		for (const listener of connectionListeners) listener(next);
	}

	// One stream for the folder's lifetime. A dropped stream reconnects, then
	// rereads the snapshot and reports a change, since events were missed.
	const events = (async () => {
		let first = true;
		while (!controller.signal.aborted) {
			try {
				if (!first) {
					setSnapshot((await call(['git', 'snapshot'], [])) as GitSnapshot);
					for (const listener of changeListeners) listener();
				}
				first = false;
				setConnected(true);
				await transport.events((event) => {
					if (controller.signal.aborted) return;
					if (event.type === 'git') setSnapshot(event.snapshot);
					else if (event.type === 'files')
						for (const listener of changeListeners) listener();
					else if (event.type === 'close-requested')
						for (const listener of closeListeners) listener();
				}, controller.signal);
			} catch {
				// Reported through `connected`; the loop retries.
			}
			setConnected(false);
			if (controller.signal.aborted) return;
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					controller.signal.removeEventListener('abort', done);
					resolve();
				};
				const timer = setTimeout(done, RECONNECT_MS);
				controller.signal.addEventListener('abort', done, { once: true });
			});
		}
	})();

	/**
	 * One folder method as a bridged call. Its arguments are detached here,
	 * synchronously, before anything is sent: the content, the capture or entry
	 * it is conditional on, and a row's values are what the caller passed at
	 * this moment, whatever the caller does with its objects afterward.
	 */
	const method =
		(path: readonly string[]) =>
		(...args: unknown[]) =>
			fileCall(path, detach(args));

	const tables: Record<string, Record<string, unknown>> = {};
	for (const name of Object.keys(definition.tables)) {
		const table: Record<string, unknown> = { name };
		for (const verb of TABLE_METHODS)
			table[verb] = method(['tables', name, verb]);
		tables[name] = Object.freeze(table);
	}

	const kv: Record<string, unknown> = {};
	for (const verb of KV_METHODS) kv[verb] = method(['kv', verb]);

	const files: Record<string, unknown> = {};
	for (const verb of FILE_METHODS) files[verb] = method(['files', verb]);
	// The host answers with bytes; the page owns the Blob.
	const open: FolderFiles['open'] = async (path) => {
		const read = await fileCall<Result<Uint8Array<ArrayBuffer>, FileError>>(
			['files', 'open'],
			[path],
		);
		if (read.error) return read;
		return Ok(new Blob([read.data]));
	};
	files.open = open;

	const git: Record<string, unknown> = {
		get snapshot() {
			return snapshot;
		},
		subscribe(listener: (snapshot: GitSnapshot) => void) {
			listener(snapshot);
			snapshotListeners.add(listener);
			return () => snapshotListeners.delete(listener);
		},
	};
	for (const method of GIT_RESULT_METHODS)
		git[method] = (...args: unknown[]) => gitCall(method, args);
	const commit: FolderGit['commit'] = async () => {
		if (controller.signal.aborted) return { status: 'closed' };
		try {
			return (await call(['git', 'commit'], [])) as Awaited<
				ReturnType<FolderGit['commit']>
			>;
		} catch (cause) {
			return {
				status: 'unconfirmed',
				error: GitError.Unconfirmed({ operation: 'commit', cause }).error
					.message,
			};
		}
	};
	const push: FolderGit['push'] = async ({ signal } = {}) => {
		if (controller.signal.aborted) return { status: 'closed' };
		try {
			return await until(
				call(['git', 'push'], []) as ReturnType<FolderGit['push']>,
				signal,
				() => ({ status: 'stoppedWaiting' }),
			);
		} catch (cause) {
			return {
				status: 'unconfirmed',
				error: GitError.Unconfirmed({ operation: 'push', cause }).error.message,
			};
		}
	};
	const commitAndPush: FolderGit['commitAndPush'] = async ({ signal } = {}) => {
		if (controller.signal.aborted)
			return { commit: { status: 'closed' }, push: { status: 'closed' } };
		try {
			return await until(
				call(['git', 'commitAndPush'], []) as ReturnType<
					FolderGit['commitAndPush']
				>,
				signal,
				() => ({
					commit: { status: 'stoppedWaiting' },
					push: { status: 'stoppedWaiting' },
				}),
			);
		} catch (cause) {
			return {
				commit: {
					status: 'unconfirmed',
					error: GitError.Unconfirmed({ operation: 'commitAndPush', cause })
						.error.message,
				},
				push: {
					status: 'unconfirmed',
					error: GitError.Unconfirmed({ operation: 'commitAndPush', cause })
						.error.message,
				},
			};
		}
	};
	const fetch: FolderGit['fetch'] = ({ signal } = {}) =>
		until(
			gitCall<Awaited<ReturnType<FolderGit['fetch']>>>('fetch', []),
			signal,
			() => GitError.StoppedWaiting({ operation: 'fetch' }),
		);
	Object.assign(git, { commit, push, commitAndPush, fetch });

	// The callback runs here, in the page, and only when the client is open.
	// What it named is one call: the host publishes it through the real
	// folder's batch, so a lost reply leaves the whole batch unconfirmed.
	const tableNames = Object.keys(definition.tables);
	const batch: FolderAccess<TDefinition>['batch'] = (collect) => {
		if (controller.signal.aborted) return Promise.resolve(FileError.Closed());
		const recorded = recordBatch<TDefinition>(tableNames, collect);
		if (recorded.error) return Promise.resolve(recorded);
		// Already detached, mutation by mutation, as each was named.
		return fileCall(['batch'], [recorded.data]);
	};

	const folder = Object.freeze({
		tables: Object.freeze(tables),
		kv: Object.freeze(kv),
		files: Object.freeze(files),
		git: Object.freeze(git),
		batch,
	}) as unknown as FolderAccess<TDefinition>;

	return {
		folder,
		close() {
			closing ??= (async () => {
				controller.abort();
				await Promise.allSettled([...inFlight, events]);
				snapshotListeners.clear();
				changeListeners.clear();
				closeListeners.clear();
				connectionListeners.clear();
			})();
			return closing;
		},
		onExternalChange(listener) {
			changeListeners.add(listener);
			return () => changeListeners.delete(listener);
		},
		onCloseRequested(listener) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		get connected() {
			return connected;
		},
		onConnection(listener) {
			connectionListeners.add(listener);
			return () => connectionListeners.delete(listener);
		},
	};
}
