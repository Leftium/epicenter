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

import type { DataDefinition } from '@epicenter/app/definition';
import {
	FileError,
	type FolderAccess,
	type FolderFiles,
	type FolderGit,
	GitError,
	type GitSnapshot,
} from '@epicenter/app/files';
import { Ok, type Result } from 'wellcrafted/result';

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
	'write',
	'remove',
	'move',
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

	const tables: Record<string, Record<string, unknown>> = {};
	for (const name of Object.keys(definition.tables)) {
		const table: Record<string, unknown> = { name };
		for (const method of TABLE_METHODS)
			table[method] = (...args: unknown[]) =>
				fileCall(['tables', name, method], args);
		tables[name] = Object.freeze(table);
	}

	const kv: Record<string, unknown> = {};
	for (const method of KV_METHODS)
		kv[method] = (...args: unknown[]) => fileCall(['kv', method], args);

	const files: Record<string, unknown> = {};
	for (const method of FILE_METHODS)
		files[method] = (...args: unknown[]) => fileCall(['files', method], args);
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

	const folder = Object.freeze({
		tables: Object.freeze(tables),
		kv: Object.freeze(kv),
		files: Object.freeze(files),
		git: Object.freeze(git),
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
