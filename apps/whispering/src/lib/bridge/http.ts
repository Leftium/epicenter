/**
 * The folder bridge over loopback HTTP: `fetch` against the folder host that
 * serves this page. The desktop shell injects the per-launch token; without it
 * the host answers nothing.
 */
import { decode, encode } from './codec.js';
import type { BridgeEvent, FolderTransport } from './folder-client.js';

export type BridgeConnection = {
	/** The host's origin, such as `http://127.0.0.1:49321`. */
	readonly origin: string;
	readonly token: string;
	/** Injected in tests; defaults to the page's `fetch`. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type HttpBridge = {
	readonly transport: FolderTransport;
	/** An application operation outside the folder API. Rejects on a fault. */
	app<T>(op: string, payload?: Record<string, unknown>): Promise<T>;
};

type Reply = { ok?: unknown; fault?: string };

export function createHttpBridge({
	origin,
	token,
	fetch: send = (input, init) => fetch(input, init),
}: BridgeConnection): HttpBridge {
	const headers = {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	};

	async function post(route: string, body: unknown): Promise<unknown> {
		const response = await send(`${origin}${route}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
		let reply: Reply;
		try {
			reply = (await response.json()) as Reply;
		} catch {
			throw new Error(`The folder host answered ${response.status}`);
		}
		if (reply.fault !== undefined) throw new Error(reply.fault);
		if (!response.ok)
			throw new Error(`The folder host answered ${response.status}`);
		return decode(reply.ok);
	}

	return {
		transport: {
			call: (path, args) => post('/bridge/call', { path, args: encode(args) }),
			async events(onEvent, signal) {
				const response = await send(`${origin}/bridge/events`, {
					headers: { authorization: headers.authorization },
					signal,
				});
				if (!response.ok || response.body === null)
					throw new Error(`The folder host answered ${response.status}`);
				const reader = response.body.getReader();
				const stop = () => {
					void reader.cancel().catch(() => {});
				};
				signal.addEventListener('abort', stop, { once: true });
				if (signal.aborted) stop();
				const decoder = new TextDecoder();
				let pending = '';
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) return;
						pending += decoder.decode(value, { stream: true });
						let newline = pending.indexOf('\n');
						while (newline >= 0) {
							const line = pending.slice(0, newline);
							pending = pending.slice(newline + 1);
							if (line.trim() !== '')
								onEvent(decode(JSON.parse(line)) as BridgeEvent);
							newline = pending.indexOf('\n');
						}
					}
				} finally {
					signal.removeEventListener('abort', stop);
					reader.releaseLock();
				}
			},
		},
		app: <T>(op: string, payload: Record<string, unknown> = {}) =>
			post('/bridge/app', { op, payload: encode(payload) }) as Promise<T>,
	};
}
