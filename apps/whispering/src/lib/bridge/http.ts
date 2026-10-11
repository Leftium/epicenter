/**
 * The page's link to the Whispering host over loopback HTTP: `fetch` against
 * the process that serves this page. The desktop shell injects the per-launch
 * token; without it the host answers nothing.
 *
 * It carries application operations and the host's event stream, and nothing
 * of the folder. The page's folder is the desktop shell's own, opened through
 * `@epicenter/folder/tauri`.
 */
import { decode, encode } from './codec.js';

export type BridgeConnection = {
	/** The host's origin, such as `http://127.0.0.1:49321`. */
	readonly origin: string;
	readonly token: string;
	/** Injected in tests; defaults to the page's `fetch`. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type HostEvent =
	/** The shell wants to close and asks whether the page may be dropped. */
	{ readonly type: 'close-requested' } | { readonly type: 'ping' };

export type HttpBridge = {
	/** An application operation. Rejects when the host is unreachable or faults. */
	app<T>(op: string, payload?: Record<string, unknown>): Promise<T>;
	/** Delivers host events until `signal` aborts; resolves when the stream ends. */
	events(
		onEvent: (event: HostEvent) => void,
		signal: AbortSignal,
	): Promise<void>;
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

	return {
		async app<T>(op: string, payload: Record<string, unknown> = {}) {
			const response = await send(`${origin}/bridge/app`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ op, payload: encode(payload) }),
			});
			let reply: Reply;
			try {
				reply = (await response.json()) as Reply;
			} catch {
				throw new Error(`The Whispering host answered ${response.status}`);
			}
			if (reply.fault !== undefined) throw new Error(reply.fault);
			if (!response.ok)
				throw new Error(`The Whispering host answered ${response.status}`);
			return decode(reply.ok) as T;
		},
		async events(onEvent, signal) {
			const response = await send(`${origin}/bridge/events`, {
				headers: { authorization: headers.authorization },
				signal,
			});
			if (!response.ok || response.body === null)
				throw new Error(`The Whispering host answered ${response.status}`);
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
							onEvent(decode(JSON.parse(line)) as HostEvent);
						newline = pending.indexOf('\n');
					}
				}
			} finally {
				signal.removeEventListener('abort', stop);
				reader.releaseLock();
			}
		},
	};
}
