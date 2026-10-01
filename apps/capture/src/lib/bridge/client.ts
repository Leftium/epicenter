/**
 * The page's side of the Capture folder bridge: a transport over `fetch`, and
 * a folder whose methods are calls to the host.
 *
 * A folder method that ran arrives with its own `Result`, so `Conflict` and
 * `NotFound` keep their fields. A call that did not run (the host is gone,
 * the session was refused, the folder could not be opened) becomes the
 * failure its method already reports: an `Io` error for file and table
 * methods, a failed outcome for a commit. No folder method throws, so a draft
 * that cannot reach the host shows a failed save and keeps its input.
 *
 * This module holds no folder handle and imports only types from the files
 * package. Closing it stops this page's calls and its event stream; the
 * folder in the host stays open.
 */
import type {
	CommitOutcome,
	FileError,
	GitSnapshot,
} from '@epicenter/app/files';
import { CAPTURES_TABLE } from '@epicenter/capture';
import type { CaptureFolder } from '../platform/types.js';
import { decode, encode } from './codec.js';
import { BRIDGE_PATH, type BridgeEvent, type HostInfo } from './contract.js';

type StreamEvent = BridgeEvent | { readonly type: 'reconnected' };

export type BridgeTransport = {
	/** Resolves with the method's own return value. Rejects when the call did not run. */
	call(path: readonly string[], args: readonly unknown[]): Promise<unknown>;
	/**
	 * Deliver events until the transport closes, reconnecting after a dropped
	 * or silent stream. `reconnected` follows each stream after the first.
	 */
	listen(onEvent: (event: StreamEvent) => void): void;
	/** Refuse new calls, end the event stream, and wait for calls in flight. */
	close(): Promise<void>;
};

const CLOSED = 'This Capture window closed its folder.';

export function createBridgeTransport({
	origin = '',
	fetch: send = globalThis.fetch.bind(globalThis),
	retryMs = 1000,
	silenceMs = 15_000,
}: {
	/** The host's origin; empty for same-origin requests. */
	origin?: string;
	fetch?: (request: Request) => Promise<Response>;
	retryMs?: number;
	/** A stream with no bytes for this long is treated as dropped. */
	silenceMs?: number;
} = {}): BridgeTransport {
	const lifetime = new AbortController();
	const inFlight = new Set<Promise<unknown>>();

	async function post(
		path: readonly string[],
		args: readonly unknown[],
	): Promise<unknown> {
		let response: Response;
		try {
			response = await send(
				new Request(`${origin}${BRIDGE_PATH}/call`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(encode({ path, args })),
				}),
			);
		} catch (cause) {
			throw new Error(
				`Epicenter did not answer (${cause instanceof Error ? cause.message : String(cause)}).`,
			);
		}
		// A refusal from the host's own gate is text, not a bridge reply.
		const reply = (await response.json().catch(() => null)) as {
			ok?: unknown;
			fault?: unknown;
		} | null;
		if (typeof reply === 'object' && reply !== null && 'ok' in reply)
			return decode(reply.ok);
		throw new Error(
			typeof reply?.fault === 'string'
				? reply.fault
				: `Epicenter answered ${response.status}.`,
		);
	}

	/** One stream, until it ends, fails, or goes silent. */
	async function stream(
		onEvent: (event: BridgeEvent) => void,
		onOpen: () => void,
	) {
		const attempt = new AbortController();
		const abort = () => attempt.abort();
		lifetime.signal.addEventListener('abort', abort, { once: true });
		let silence: ReturnType<typeof setTimeout> | undefined;
		const heard = () => {
			clearTimeout(silence);
			silence = setTimeout(abort, silenceMs);
		};
		try {
			heard();
			const response = await send(
				new Request(`${origin}${BRIDGE_PATH}/events`, {
					signal: attempt.signal,
				}),
			);
			if (!response.ok || response.body === null)
				throw new Error(`The event stream answered ${response.status}`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let pending = '';
			let opened = false;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				heard();
				pending += decoder.decode(value, { stream: true });
				let end = pending.indexOf('\n');
				while (end >= 0) {
					const line = pending.slice(0, end).trim();
					pending = pending.slice(end + 1);
					if (line !== '') {
						if (!opened) {
							opened = true;
							onOpen();
						}
						onEvent(decode(JSON.parse(line)) as BridgeEvent);
					}
					end = pending.indexOf('\n');
				}
			}
		} finally {
			clearTimeout(silence);
			lifetime.signal.removeEventListener('abort', abort);
			attempt.abort();
		}
	}

	return {
		call(path, args) {
			if (lifetime.signal.aborted) return Promise.reject(new Error(CLOSED));
			// A save already sent is not cut off when the page leaves.
			const running = post(path, args);
			inFlight.add(running);
			const forget = () => inFlight.delete(running);
			running.then(forget, forget);
			return running;
		},
		listen(onEvent) {
			void (async () => {
				let connected = false;
				while (!lifetime.signal.aborted) {
					try {
						await stream(onEvent, () => {
							// A dropped stream may have missed changes; say so once the
							// new one is live, so the reread reaches a host that answers.
							if (connected) onEvent({ type: 'reconnected' });
							connected = true;
						});
					} catch {
						// The stream dropped or never opened; try again below.
					}
					if (lifetime.signal.aborted) return;
					await new Promise<void>((resolve) => {
						const timer = setTimeout(done, retryMs);
						function done() {
							clearTimeout(timer);
							lifetime.signal.removeEventListener('abort', done);
							resolve();
						}
						lifetime.signal.addEventListener('abort', done, { once: true });
					});
				}
			})();
		},
		async close() {
			lifetime.abort();
			await Promise.allSettled([...inFlight]);
		},
	};
}

const asError = (cause: unknown) =>
	cause instanceof Error ? cause : new Error(String(cause));

/** The failure a file or table method reports when its call never ran. */
function unreachable(path: string, cause: unknown) {
	const error = asError(cause);
	return {
		data: null,
		error: {
			name: 'Io',
			message: `Could not reach the Capture folder: ${error.message}`,
			path,
			operation: 'reach',
			cause: error,
		} satisfies Extract<FileError, { name: 'Io' }>,
	};
}

type RemoteFolder = CaptureFolder & {
	/** Replace the Git snapshot, from an event or a fresh call. */
	receiveSnapshot(snapshot: GitSnapshot): void;
};

/**
 * A folder whose every method is a bridge call. `git.snapshot` is the last
 * snapshot the host sent; the caller feeds it from the event stream.
 */
export function createRemoteFolder(
	transport: BridgeTransport,
	initial: GitSnapshot,
): RemoteFolder {
	/** A method's own Result, or `Io` when the call never ran. */
	const reaching =
		(path: readonly string[], pathOf: (first: unknown) => string) =>
		(...args: unknown[]) =>
			transport
				.call(path, args)
				.catch((cause) => unreachable(pathOf(args[0]), cause));
	const literal = (first: unknown) => (typeof first === 'string' ? first : '');
	const entryPath = (first: unknown) =>
		typeof first === 'object' && first !== null && 'path' in first
			? String(first.path)
			: CAPTURES_TABLE;

	let snapshot = initial;
	const listeners = new Set<(snapshot: GitSnapshot) => void>();

	return {
		tables: {
			captures: {
				list: reaching(['captures', 'list'], () => CAPTURES_TABLE),
				get: reaching(['captures', 'get'], literal),
				create: reaching(['captures', 'create'], () => CAPTURES_TABLE),
				writeSource: reaching(['captures', 'writeSource'], entryPath),
				delete: reaching(['captures', 'delete'], entryPath),
			} as unknown as CaptureFolder['tables']['captures'],
		},
		files: {
			read: reaching(['files', 'read'], literal),
			write: reaching(['files', 'write'], literal),
		} as unknown as CaptureFolder['files'],
		git: {
			get snapshot() {
				return snapshot;
			},
			subscribe(listener) {
				listener(snapshot);
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			commit: () =>
				(transport.call(['git', 'commit'], []) as Promise<CommitOutcome>).catch(
					(cause): CommitOutcome => ({
						status: 'failed',
						error: asError(cause).message,
					}),
				),
		},
		receiveSnapshot(next) {
			snapshot = next;
			for (const listener of listeners) listener(next);
		},
	};
}

/**
 * Open the host's Capture folder for this page: the folder, where it is, and
 * a change hint. Rejects when the host cannot open the directory, with the
 * host's reason.
 */
export async function openBridgeFolder(transport: BridgeTransport) {
	let info: HostInfo;
	let snapshot: GitSnapshot;
	try {
		[info, snapshot] = (await Promise.all([
			transport.call(['host', 'info'], []),
			transport.call(['git', 'snapshot'], []),
		])) as [HostInfo, GitSnapshot];
	} catch (cause) {
		await transport.close();
		throw cause;
	}
	const folder = createRemoteFolder(transport, snapshot);
	const changeListeners = new Set<() => void>();
	transport.listen((event) => {
		switch (event.type) {
			case 'git':
				folder.receiveSnapshot(event.snapshot as GitSnapshot);
				break;
			case 'files':
			// A dropped stream may have missed changes; reread to be sure.
			case 'reconnected':
				for (const listener of changeListeners) listener();
				break;
		}
	});
	return {
		folder: folder as CaptureFolder,
		root: info.root,
		onExternalChange(listener: () => void) {
			changeListeners.add(listener);
			return () => changeListeners.delete(listener);
		},
		close: () => transport.close(),
	};
}
