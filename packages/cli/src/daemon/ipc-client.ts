/**
 * HTTP-over-unix-socket IPC client for the long-lived `epicenter up` daemon.
 *
 * Counterpart to `ipc-server.ts`. Two surfaces:
 *
 * - {@link ipcPing}: cheap liveness probe used by sibling attach and
 *   orphan inspection. Never throws; returns `false` on any connect /
 *   timeout / non-200 failure so callers can branch without try/catch noise.
 * - {@link ipcCall}: request/response over `fetch(url, { unix })`. The 200
 *   body is the server-built `Result<T, SerializedError>` directly; transport
 *   failures collapse into `IpcClientError` variants so "no daemon running"
 *   is just another `Err` outcome.
 *
 * `fetch` rejects on missing-socket / ECONNREFUSED, so we use the request
 * itself as the single liveness signal. No `existsSync` pre-check.
 *
 * Wire format and security model are deliberately internal; see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol".
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import type { SerializedError } from './ipc-server.js';

/**
 * Tagged-error variants emitted by the IPC client itself (not by the
 * server). `NoDaemon` covers any connect-level failure (missing socket,
 * ECONNREFUSED, transport closed); `Timeout` is the local deadline
 * expiring; `HandlerCrashed` is a non-200 response (the server's
 * `error()` callback fired).
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

/** Default per-call timeout (ms) for {@link ipcCall}. */
const DEFAULT_CALL_TIMEOUT_MS = 5000;

/** Default ping timeout (ms). Tight on purpose: ping is a fast-path probe. */
const DEFAULT_PING_TIMEOUT_MS = 250;

/**
 * Cheap liveness probe. POSTs `/ping` and resolves `true` iff the daemon
 * answers with 200 within `timeoutMs`.
 *
 * Never throws. Connection failures (`ECONNREFUSED`, missing socket file,
 * timeout, non-200) all resolve `false` so callers can use this as a
 * boolean precondition without try/catch.
 */
export async function ipcPing(
	socketPath: string,
	timeoutMs: number = DEFAULT_PING_TIMEOUT_MS,
): Promise<boolean> {
	try {
		const res = await fetch('http://daemon/ping', {
			unix: socketPath,
			method: 'POST',
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Single-shot request/response. Resolves with the server-built `Result<T, E>`
 * on a 200 response. Connection-level failures collapse into
 * {@link IpcClientError} variants; handler-level errors flow through as
 * the server-side `SerializedError`.
 */
export async function ipcCall<T = unknown>(
	socketPath: string,
	cmd: string,
	args?: unknown,
	timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<Result<T, IpcClientError | SerializedError>> {
	const body = args === undefined ? '' : JSON.stringify(args);

	let res: Response;
	try {
		res = await fetch(`http://daemon/${cmd}`, {
			unix: socketPath,
			method: 'POST',
			body,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		if (cause instanceof Error && cause.name === 'TimeoutError') {
			return IpcClientError.Timeout({ socketPath, timeoutMs }) as Result<
				T,
				IpcClientError
			>;
		}
		return IpcClientError.NoDaemon({ socketPath, cause }) as Result<
			T,
			IpcClientError
		>;
	}

	if (!res.ok) {
		const error = (await res.json().catch(() => ({
			name: 'HandlerCrashed',
			message: `server returned ${res.status}`,
		}))) as SerializedError;
		return { data: null, error } as Result<T, SerializedError>;
	}

	return (await res.json()) as Result<T, SerializedError>;
}
