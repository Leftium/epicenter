/**
 * The page's side of the folder bridge: a transport over `fetch`, and a
 * folder object whose methods are calls to the host.
 *
 * Nothing here is Honeycrisp's. The folder's `Result` values arrive
 * unchanged, so `Conflict`, `NotFound`, and `Partial` keep their fields. A
 * transport failure (the host is gone, the token is refused) throws; callers
 * that hold a draft treat a throw as a failed save and keep the draft.
 */
import type { GitSnapshot } from '@epicenter/app/files';
import { decode, encode } from './codec.js';
import {
	type AppRequest,
	type BridgeEvent,
	type BridgeReply,
	FOLDER_METHODS,
} from './contract.js';

export type BridgeTransport = {
	call(path: readonly string[], args: readonly unknown[]): Promise<unknown>;
	app<T>(request: AppRequest): Promise<T>;
	/** Deliver events until `signal` aborts, reconnecting after a dropped stream. */
	listen(
		onEvent: (event: BridgeEvent | { type: 'reconnected' }) => void,
		signal: AbortSignal,
	): void;
};

export function createBridgeTransport({
	origin,
	token,
	fetch: send = globalThis.fetch.bind(globalThis),
	retryMs = 1000,
}: {
	/** The host's origin; empty for same-origin requests. */
	origin: string;
	token: string;
	fetch?: (request: Request) => Promise<Response>;
	retryMs?: number;
}): BridgeTransport {
	const headers = {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	};

	async function post(route: string, body: unknown): Promise<unknown> {
		const response = await send(
			new Request(`${origin}/bridge/${route}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(encode(body)),
			}),
		);
		let reply: BridgeReply;
		try {
			reply = (await response.json()) as BridgeReply;
		} catch {
			throw new Error(`The notes folder host answered ${response.status}`);
		}
		if ('fault' in reply) throw new Error(reply.fault);
		return decode(reply.ok);
	}

	async function stream(
		onEvent: (event: BridgeEvent) => void,
		signal: AbortSignal,
	) {
		const response = await send(
			new Request(`${origin}/bridge/events`, { headers, signal }),
		);
		if (!response.ok || response.body === null)
			throw new Error(`The event stream answered ${response.status}`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			pending += decoder.decode(value, { stream: true });
			let end = pending.indexOf('\n');
			while (end >= 0) {
				const line = pending.slice(0, end).trim();
				pending = pending.slice(end + 1);
				if (line !== '') onEvent(decode(JSON.parse(line)) as BridgeEvent);
				end = pending.indexOf('\n');
			}
		}
	}

	return {
		call: (path, args) => post('call', { path, args }),
		app: <T>(request: AppRequest) => post('app', request) as Promise<T>,
		listen(onEvent, signal) {
			void (async () => {
				let connected = false;
				while (!signal.aborted) {
					try {
						if (connected) onEvent({ type: 'reconnected' });
						connected = true;
						await stream(onEvent, signal);
					} catch {
						// The stream dropped or never opened; try again below.
					}
					if (signal.aborted) return;
					await new Promise((resolve) => setTimeout(resolve, retryMs));
				}
			})();
		},
	};
}

type RemoteFolder<TFolder> = TFolder & {
	/** Replace the Git snapshot, from an event or a fresh call. */
	receiveSnapshot(snapshot: GitSnapshot): void;
};

/**
 * A folder whose every method is a bridge call. `git.snapshot` is the last
 * snapshot the host sent; the caller feeds it from the event stream.
 */
export function createRemoteFolder<TFolder>(
	transport: BridgeTransport,
	{
		tables,
		snapshot: initial,
		signal,
	}: { tables: readonly string[]; snapshot: GitSnapshot; signal: AbortSignal },
): RemoteFolder<TFolder> {
	const methods = (
		prefix: readonly string[],
		names: readonly string[],
	): Record<string, (...args: unknown[]) => Promise<unknown>> =>
		Object.fromEntries(
			names.map((name) => [
				name,
				(...args: unknown[]) => transport.call([...prefix, name], args),
			]),
		);

	let snapshot = initial;
	const listeners = new Set<(snapshot: GitSnapshot) => void>();

	const files = methods(['files'], FOLDER_METHODS.files);
	const git = methods(
		['git'],
		FOLDER_METHODS.git.filter((name) => name !== 'snapshot'),
	);

	const folder = {
		tables: Object.fromEntries(
			tables.map((name) => [
				name,
				{ name, ...methods(['tables', name], FOLDER_METHODS.tables) },
			]),
		),
		kv: methods(['kv'], FOLDER_METHODS.kv),
		files: {
			...files,
			// Bytes cross the bridge; the page rebuilds the Blob.
			async open(path: string) {
				const result = (await transport.call(['files', 'open'], [path])) as {
					data: Uint8Array | null;
					error: unknown;
				};
				if (result.error !== null || result.data === null) return result;
				return {
					data: new Blob([result.data as Uint8Array<ArrayBuffer>]),
					error: null,
				};
			},
		},
		git: {
			...git,
			get snapshot() {
				return snapshot;
			},
			subscribe(listener: (snapshot: GitSnapshot) => void) {
				listeners.add(listener);
				listener(snapshot);
				return () => listeners.delete(listener);
			},
		},
		signal,
		receiveSnapshot(next: GitSnapshot) {
			snapshot = next;
			for (const listener of listeners) listener(next);
		},
	};
	return folder as unknown as RemoteFolder<TFolder>;
}
