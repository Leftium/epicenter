/**
 * Newline-delimited JSON IPC client for the long-lived `epicenter up` daemon.
 *
 * Counterpart to `ipc-server.ts`. Three surfaces:
 *
 * - {@link ipcPing} — cheap liveness probe used by sibling auto-detect
 *   (Wave 6) and orphan inspection (Wave 2). Never throws; returns `false`
 *   on any connect / timeout / parse failure so callers can branch
 *   without try/catch noise.
 * - {@link ipcCall} — request/response with a single terminal frame.
 *   Connection failures collapse into the `NoDaemon` error variant so
 *   "no daemon running" is just another `{ok: false}` outcome.
 * - {@link ipcStream} — async iterator over a streamed reply. Yields each
 *   `data` payload until the server sends `end: true` or an error frame.
 *
 * Wire format and security model are deliberately internal — see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol".
 */

import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

import type { IpcResponse } from './ipc-server.js';

/**
 * Result shape returned by {@link ipcCall} and the per-frame yield of
 * {@link ipcStream}'s underlying request. The `NoDaemon` variant signals a
 * transport-level failure (no socket, connect refused, timeout) — distinct
 * from a handler-level error returned by a live daemon.
 */
export type IpcCallResult<T = unknown> =
	| { ok: true; data: T }
	| { ok: false; error: { name: string; message: string } };

/** Default per-frame read timeout (ms) for {@link ipcCall} / {@link ipcStream}. */
const DEFAULT_CALL_TIMEOUT_MS = 5000;

/** Default ping timeout (ms). Tight on purpose: ping is a fast-path probe. */
const DEFAULT_PING_TIMEOUT_MS = 250;

/**
 * Cheap liveness probe. Sends `{cmd: 'ping'}` and resolves `true` iff the
 * daemon answers with any `ok: true` frame within `timeoutMs`.
 *
 * Never throws. Connection failures (`ECONNREFUSED`, `ENOENT`, missing
 * socket file, timeout) all resolve `false` so callers can use this as a
 * boolean precondition without try/catch.
 */
export async function ipcPing(
	socketPath: string,
	timeoutMs: number = DEFAULT_PING_TIMEOUT_MS,
): Promise<boolean> {
	if (!existsSync(socketPath)) return false;

	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			try {
				rl.close();
			} catch {
				// best effort
			}
			socket.destroy();
			clearTimeout(timer);
			resolve(value);
		};

		const socket = connect(socketPath);
		const rl = createInterface({ input: socket });

		const timer = setTimeout(() => finish(false), timeoutMs);

		rl.on('line', (line) => {
			let frame: IpcResponse;
			try {
				frame = JSON.parse(line) as IpcResponse;
			} catch {
				return;
			}
			// Per the W3 contract, the server may emit `BadRequest` with id ''
			// for un-parseable lines — drop frames with no/empty id silently.
			if (!('id' in frame) || frame.id !== 'ping') return;
			finish(frame.ok === true);
		});

		socket.on('connect', () => {
			socket.write(`${JSON.stringify({ id: 'ping', cmd: 'ping' })}\n`);
		});

		socket.on('error', () => finish(false));
		socket.on('close', () => finish(false));
	});
}

/**
 * Single-shot request/response. Resolves with the first non-streamed frame
 * matching the request `id`. Connection-level failures collapse into the
 * `NoDaemon` error variant rather than throwing.
 */
export async function ipcCall<T = unknown>(
	socketPath: string,
	cmd: string,
	args?: unknown,
	options?: { timeoutMs?: number },
): Promise<IpcCallResult<T>> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
	const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

	if (!existsSync(socketPath)) {
		return {
			ok: false,
			error: {
				name: 'NoDaemon',
				message: `no socket at ${socketPath}`,
			},
		};
	}

	return new Promise<IpcCallResult<T>>((resolve) => {
		let settled = false;
		const finish = (result: IpcCallResult<T>) => {
			if (settled) return;
			settled = true;
			try {
				rl.close();
			} catch {
				// best effort
			}
			socket.destroy();
			clearTimeout(timer);
			resolve(result);
		};

		const socket = connect(socketPath);
		const rl = createInterface({ input: socket });

		const timer = setTimeout(() => {
			finish({
				ok: false,
				error: { name: 'NoDaemon', message: `timeout after ${timeoutMs}ms` },
			});
		}, timeoutMs);

		rl.on('line', (line) => {
			let frame: IpcResponse;
			try {
				frame = JSON.parse(line) as IpcResponse;
			} catch {
				return;
			}
			// Drop frames with no/empty id (e.g. server BadRequest for blank lines).
			if (!('id' in frame) || !frame.id) return;
			if (frame.id !== id) return;

			if (frame.ok) {
				finish({ ok: true, data: frame.data as T });
			} else {
				finish({ ok: false, error: frame.error });
			}
		});

		socket.on('connect', () => {
			socket.write(`${JSON.stringify({ id, cmd, args })}\n`);
		});

		socket.on('error', (err: NodeJS.ErrnoException) => {
			finish({
				ok: false,
				error: {
					name: 'NoDaemon',
					message: `${err.code ?? 'connect failed'}: ${err.message}`,
				},
			});
		});

		socket.on('close', () => {
			finish({
				ok: false,
				error: {
					name: 'NoDaemon',
					message: 'connection closed before response',
				},
			});
		});
	});
}

/**
 * Iterate over a streamed reply, yielding each `data` payload in order.
 * The iterator completes when the server sends a frame with `end: true`,
 * an error frame (which throws), or the connection closes.
 *
 * Connection-level failures throw; handler-level error frames also throw
 * with the wire `{name, message}` preserved as `Error.name` / `Error.message`.
 * Streaming is rare enough that try/catch at call sites is acceptable.
 */
export async function* ipcStream<T = unknown>(
	socketPath: string,
	cmd: string,
	args?: unknown,
): AsyncGenerator<T> {
	if (!existsSync(socketPath)) {
		const err = new Error(`no socket at ${socketPath}`);
		err.name = 'NoDaemon';
		throw err;
	}

	const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

	type Item =
		| { kind: 'data'; value: T }
		| { kind: 'end' }
		| { kind: 'error'; name: string; message: string };

	const queue: Item[] = [];
	const waiters: Array<(item: Item) => void> = [];
	const push = (item: Item) => {
		const w = waiters.shift();
		if (w) w(item);
		else queue.push(item);
	};
	const next = (): Promise<Item> =>
		queue.length > 0
			? Promise.resolve(queue.shift()!)
			: new Promise<Item>((resolve) => waiters.push(resolve));

	let socket: Socket;
	try {
		socket = connect(socketPath);
	} catch (cause) {
		const err = new Error(
			cause instanceof Error ? cause.message : String(cause),
		);
		err.name = 'NoDaemon';
		throw err;
	}

	const rl = createInterface({ input: socket });
	rl.on('line', (line) => {
		let frame: IpcResponse;
		try {
			frame = JSON.parse(line) as IpcResponse;
		} catch {
			return;
		}
		if (!('id' in frame) || !frame.id) return;
		if (frame.id !== id) return;

		if (!frame.ok) {
			push({ kind: 'error', name: frame.error.name, message: frame.error.message });
			return;
		}
		if (frame.data !== undefined) {
			push({ kind: 'data', value: frame.data as T });
		}
		if (frame.end) push({ kind: 'end' });
	});

	socket.on('connect', () => {
		socket.write(`${JSON.stringify({ id, cmd, args })}\n`);
	});

	socket.on('error', (err: NodeJS.ErrnoException) => {
		push({
			kind: 'error',
			name: 'NoDaemon',
			message: `${err.code ?? 'connect failed'}: ${err.message}`,
		});
	});

	socket.on('close', () => push({ kind: 'end' }));

	try {
		while (true) {
			const item = await next();
			if (item.kind === 'end') return;
			if (item.kind === 'error') {
				const err = new Error(item.message);
				err.name = item.name;
				throw err;
			}
			yield item.value;
		}
	} finally {
		try {
			rl.close();
		} catch {
			// best effort
		}
		socket.destroy();
	}
}
