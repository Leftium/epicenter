/**
 * Newline-delimited JSON IPC client for the long-lived `epicenter up` daemon.
 *
 * Counterpart to `ipc-server.ts`. Two surfaces:
 *
 * - {@link ipcPing} — cheap liveness probe used by sibling auto-detect and
 *   orphan inspection. Never throws; returns `false` on any connect / timeout
 *   / parse failure so callers can branch without try/catch noise.
 * - {@link ipcCall} — request/response with a single terminal frame.
 *   Connection failures collapse into the `IpcClientError.NoDaemon` /
 *   `IpcClientError.Timeout` variants so "no daemon running" is just
 *   another `Err` outcome.
 *
 * Wire format and security model are deliberately internal — see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol".
 */

import { existsSync } from 'node:fs';

import type { Socket } from 'bun';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import type { IpcFrame, SerializedError } from './ipc-server.js';

/**
 * Tagged-error variants emitted by the IPC client itself (not by the
 * server). `NoDaemon` covers any connect-level failure (missing socket,
 * ECONNREFUSED, transport closed before reply); `Timeout` is the local
 * deadline expiring.
 */
export const IpcClientError = defineErrors({
	NoDaemon: ({
		socketPath,
		cause,
	}: {
		socketPath: string;
		cause?: unknown;
	}) => ({
		message: `no daemon at ${socketPath}${cause ? `: ${extractErrorMessage(cause)}` : ''}`,
		socketPath,
		cause,
	}),
	Timeout: ({
		socketPath,
		timeoutMs,
	}: {
		socketPath: string;
		timeoutMs: number;
	}) => ({
		message: `timed out after ${timeoutMs}ms waiting for ${socketPath}`,
		socketPath,
		timeoutMs,
	}),
});
export type IpcClientError = InferErrors<typeof IpcClientError>;

/** Default per-frame read timeout (ms) for {@link ipcCall}. */
const DEFAULT_CALL_TIMEOUT_MS = 5000;

/** Default ping timeout (ms). Tight on purpose: ping is a fast-path probe. */
const DEFAULT_PING_TIMEOUT_MS = 250;

/** Per-connection state for line-buffered reads on the client side. */
type ClientSocketData = {
	buffer: string;
	onLine: (line: string) => void;
	onClose: () => void;
	onError: (err: unknown) => void;
};

/**
 * Open a Bun unix socket with line-buffered reads. The caller supplies
 * line/close/error callbacks; this helper handles the buffer accumulation
 * and the `Bun.connect` plumbing.
 */
async function connectLineSocket(
	socketPath: string,
	callbacks: {
		onLine: (line: string) => void;
		onClose: () => void;
		onError: (err: unknown) => void;
	},
): Promise<Socket<ClientSocketData>> {
	return Bun.connect<ClientSocketData>({
		unix: socketPath,
		socket: {
			open(socket) {
				socket.data = {
					buffer: '',
					onLine: callbacks.onLine,
					onClose: callbacks.onClose,
					onError: callbacks.onError,
				};
			},
			data(socket, chunk) {
				socket.data.buffer += chunk.toString('utf8');
				let nl = socket.data.buffer.indexOf('\n');
				while (nl !== -1) {
					const line = socket.data.buffer.slice(0, nl);
					socket.data.buffer = socket.data.buffer.slice(nl + 1);
					socket.data.onLine(line);
					nl = socket.data.buffer.indexOf('\n');
				}
			},
			close(socket) {
				socket.data.onClose();
			},
			error(socket, err) {
				socket.data.onError(err);
			},
		},
	});
}

/**
 * Cheap liveness probe. Sends `{cmd: 'ping'}` and resolves `true` iff the
 * daemon answers with any success frame within `timeoutMs`.
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
		let socket: Socket<ClientSocketData> | undefined;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			if (socket) socket.end();
			clearTimeout(timer);
			resolve(value);
		};

		const timer = setTimeout(() => finish(false), timeoutMs);

		connectLineSocket(socketPath, {
			onLine: (line) => {
				let frame: IpcFrame;
				try {
					frame = JSON.parse(line) as IpcFrame;
				} catch {
					return;
				}
				// Server may emit BadRequest with id '' for un-parseable lines —
				// drop frames with no/empty id silently.
				if (!('id' in frame) || frame.id !== 'ping') return;
				finish(frame.error === null);
			},
			onClose: () => finish(false),
			onError: () => finish(false),
		}).then(
			(s) => {
				if (settled) {
					s.end();
					return;
				}
				socket = s;
				s.write(`${JSON.stringify({ id: 'ping', cmd: 'ping' })}\n`);
			},
			() => finish(false),
		);
	});
}

/**
 * Single-shot request/response. Resolves with the first non-streamed frame
 * matching the request `id`, wrapped as a {@link Result}. Connection-level
 * failures collapse into {@link IpcClientError} variants; handler-level
 * errors flow through as the server-side `SerializedError`.
 */
export async function ipcCall<T = unknown>(
	socketPath: string,
	cmd: string,
	args?: unknown,
	timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<Result<T, IpcClientError | SerializedError>> {
	const id = `c-${Bun.randomUUIDv7()}`;

	if (!existsSync(socketPath)) {
		return IpcClientError.NoDaemon({ socketPath }) as Result<
			T,
			IpcClientError
		>;
	}

	return new Promise<Result<T, IpcClientError | SerializedError>>((resolve) => {
		let settled = false;
		let socket: Socket<ClientSocketData> | undefined;
		const finish = (result: Result<T, IpcClientError | SerializedError>) => {
			if (settled) return;
			settled = true;
			if (socket) socket.end();
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			finish(
				IpcClientError.Timeout({ socketPath, timeoutMs }) as Result<
					T,
					IpcClientError
				>,
			);
		}, timeoutMs);

		connectLineSocket(socketPath, {
			onLine: (line) => {
				let frame: IpcFrame<T>;
				try {
					frame = JSON.parse(line) as IpcFrame<T>;
				} catch {
					return;
				}
				// Drop frames with no/empty id (e.g. server BadRequest for blank lines).
				if (!('id' in frame) || !frame.id) return;
				if (frame.id !== id) return;

				if (frame.error === null) {
					finish({ data: frame.data, error: null });
				} else {
					finish({ data: null, error: frame.error });
				}
			},
			onClose: () => {
				finish(
					IpcClientError.NoDaemon({
						socketPath,
						cause: 'connection closed before response',
					}) as Result<T, IpcClientError>,
				);
			},
			onError: (err) => {
				finish(
					IpcClientError.NoDaemon({ socketPath, cause: err }) as Result<
						T,
						IpcClientError
					>,
				);
			},
		}).then(
			(s) => {
				if (settled) {
					s.end();
					return;
				}
				socket = s;
				s.write(`${JSON.stringify({ id, cmd, args })}\n`);
			},
			(err) => {
				finish(
					IpcClientError.NoDaemon({ socketPath, cause: err }) as Result<
						T,
						IpcClientError
					>,
				);
			},
		);
	});
}

