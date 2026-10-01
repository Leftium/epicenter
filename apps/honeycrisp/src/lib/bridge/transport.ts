/**
 * HTTP calls and reconnecting events for Honeycrisp's folder bridge.
 *
 * The folder's `Result` values arrive
 * unchanged, so `Conflict`, `NotFound`, and `Partial` keep their fields. A
 * transport failure (the host is gone, the token is refused) throws; callers
 * that hold a draft treat a throw as a failed save and keep the draft.
 */
import { decode, encode } from './codec.js';
import type {
	AppRequest,
	BridgeEvent,
	BridgeReply,
	FolderCallMethod,
	FolderCallPath,
} from './contract.js';

export type BridgeTransport = {
	call<TPath extends FolderCallPath>(
		path: TPath,
		args: Parameters<FolderCallMethod<TPath>>,
	): Promise<Awaited<ReturnType<FolderCallMethod<TPath>>>>;
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

	async function post<TResponse>(
		route: string,
		body: unknown,
	): Promise<TResponse> {
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
		return decode(reply.ok) as TResponse;
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
		call<TPath extends FolderCallPath>(
			path: TPath,
			args: Parameters<FolderCallMethod<TPath>>,
		) {
			return post<Awaited<ReturnType<FolderCallMethod<TPath>>>>('call', {
				path,
				args,
			});
		},
		app: <T>(request: AppRequest) => post<T>('app', request),
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
