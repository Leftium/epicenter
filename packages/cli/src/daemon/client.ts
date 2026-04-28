/**
 * Typed client for the `epicenter up` daemon, derived from the Hono app's
 * static type via `hc<DaemonApp>`. Three surfaces:
 *
 * - {@link pingDaemon}: cheap liveness probe used by sibling attach and
 *   orphan inspection. Never throws; returns `false` on any connect /
 *   timeout / non-200 failure so callers can branch without try/catch noise.
 * - {@link daemonClient}: factory returning a typed handle with one method
 *   per route (`ping`, `peers`, `list`, `run`, `shutdown`). Each method
 *   returns `Promise<Result<T, DaemonClientError | SerializedError>>`;
 *   `T` is inferred from the server's route definition, so passing the
 *   wrong shape is a compile error.
 * - {@link tryGetDaemon}: dispatch decision for sibling commands. Pings
 *   first; returns a typed client when a daemon answers, `null` otherwise.
 *
 * Connect failures (`fetch` reject on missing socket, `ECONNREFUSED`,
 * AbortSignal timeout) collapse into {@link DaemonClientError} variants so
 * "no daemon running" is just another `Err` outcome.
 *
 * Wire format and security model are deliberately internal; see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol".
 */

import { hc } from 'hono/client';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import type { ResolvedTarget } from '../util/common-options.js';
import type { DaemonApp, PeerSnapshot } from './app.js';
import { socketPathFor } from './paths.js';
import type { SerializedError } from './unix-socket.js';

/**
 * Tagged-error variants emitted by the daemon client itself (not by the
 * server). `NoDaemon` covers any connect-level failure (missing socket,
 * ECONNREFUSED, transport closed); `Timeout` is the local deadline
 * expiring; `HandlerCrashed` is a non-200 response (an unhandled
 * exception in a route or a 400 from the validator).
 */
export const DaemonClientError = defineErrors({
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
	HandlerCrashed: ({ status, cause }: { status: number; cause?: unknown }) => ({
		message: `daemon returned ${status}${cause ? `: ${extractErrorMessage(cause)}` : ''}`,
		status,
		cause,
	}),
});
export type DaemonClientError = InferErrors<typeof DaemonClientError>;

/** Default per-call timeout (ms). */
const DEFAULT_CALL_TIMEOUT_MS = 5000;

/** Default ping timeout (ms). Tight on purpose: ping is a fast-path probe. */
const DEFAULT_PING_TIMEOUT_MS = 250;

/**
 * Cheap liveness probe. POSTs `/ping` and resolves `true` iff the daemon
 * answers with 200 within `timeoutMs`. Never throws.
 */
export async function pingDaemon(
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
 * Map one route call's `Promise<Response>` onto our `Result<T, ...>` envelope.
 * Transport failures become {@link DaemonClientError} variants; non-200
 * responses become `HandlerCrashed`; 200 responses unwrap to the body's
 * own `Result` (which is what the server built).
 */
async function callRoute<T>(
	socketPath: string,
	timeoutMs: number,
	pending: Promise<Response>,
): Promise<Result<T, DaemonClientError | SerializedError>> {
	let res: Response;
	try {
		res = await pending;
	} catch (cause) {
		if (cause instanceof Error && cause.name === 'TimeoutError') {
			return DaemonClientError.Timeout({ socketPath, timeoutMs }) as Result<
				T,
				DaemonClientError
			>;
		}
		return DaemonClientError.NoDaemon({ socketPath, cause }) as Result<
			T,
			DaemonClientError
		>;
	}

	if (!res.ok) {
		return DaemonClientError.HandlerCrashed({
			status: res.status,
			cause: await res.text().catch(() => undefined),
		}) as Result<T, DaemonClientError>;
	}

	return (await res.json()) as Result<T, SerializedError>;
}

/**
 * Build a typed client for a daemon listening on `socketPath`. The returned
 * methods are derived from {@link DaemonApp} via `hc<DaemonApp>`, so call
 * sites get input-shape checking and inferred return types without
 * redeclaring the contracts.
 *
 * Each method returns `Promise<Result<T, DaemonClientError | SerializedError>>`.
 * Domain errors arrive on the `error` side of the inner Result; transport
 * failures collapse into `DaemonClientError` variants.
 */
export function daemonClient(
	socketPath: string,
	timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
) {
	const client = hc<DaemonApp>('http://daemon', {
		fetch: (input: RequestInfo | URL, init?: RequestInit) =>
			fetch(input, {
				...init,
				unix: socketPath,
				signal: AbortSignal.timeout(timeoutMs),
			}),
	});

	return {
		ping: () =>
			callRoute<'pong'>(socketPath, timeoutMs, client.ping.$post()),
		peers: (args: { workspace?: string }) =>
			callRoute<PeerSnapshot[]>(socketPath, timeoutMs, client.peers.$post({ json: args })),
		list: (args: Parameters<typeof client.list.$post>[0]['json']) =>
			callRoute<
				Result<
					import('../commands/list.js').ListSuccess,
					import('../commands/list.js').ListError
				>
			>(socketPath, timeoutMs, client.list.$post({ json: args })),
		run: (args: Parameters<typeof client.run.$post>[0]['json']) =>
			callRoute<
				Result<
					import('../commands/run.js').RunSuccess,
					import('../commands/run.js').RunError
				>
			>(socketPath, timeoutMs, client.run.$post({ json: args })),
		shutdown: () =>
			callRoute<null>(socketPath, timeoutMs, client.shutdown.$post()),
	};
}

/**
 * Public type of the typed daemon handle. Equivalent to the return of
 * {@link daemonClient}. Consumers (run/list/peers/down) import this when
 * they need to type a `DaemonClient` parameter or test seam.
 */
export type DaemonClient = ReturnType<typeof daemonClient>;

/**
 * Single dispatch decision for sibling commands. Pings the socket; if a
 * daemon answers, returns a typed {@link DaemonClient}. If no daemon is
 * alive, returns `null` and the caller falls through to its in-process
 * transient path. There is no "mismatch" state: the daemon serves every
 * workspace its config exports (Invariant 7), and an unknown
 * `--workspace` surfaces from the daemon's own `resolveEntry` lookup as
 * a normal error (same phrasing the cold path would emit).
 */
export async function tryGetDaemon(
	target: ResolvedTarget,
): Promise<DaemonClient | null> {
	const sock = socketPathFor(target.absDir);
	if (!(await pingDaemon(sock))) return null;
	return daemonClient(sock);
}
