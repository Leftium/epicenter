/**
 * Typed client for the `epicenter up` daemon, derived from the Hono app's
 * static type via `hc<DaemonApp>`. Three surfaces:
 *
 * - {@link pingDaemon}: cheap liveness probe; never throws, never returns
 *   Result. Boolean is the right shape for a fast-path predicate.
 * - {@link daemonClient}: factory returning a typed handle with one method
 *   per route. Each method returns `Promise<Result<T, DomainErr | DaemonError>>`,
 *   merging transport and domain failures into one tagged union the
 *   renderer narrows by `error.name`.
 * - {@link tryGetDaemon}: dispatch decision for sibling commands. Pings
 *   first; returns a typed client when a daemon answers, `null` otherwise.
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
 * Tagged-error variants returned by daemon client surfaces. Domain errors
 * (UsageError, PeerMiss, etc.) live alongside these in a merged union so
 * call sites narrow once on `result.error.name`. No class hierarchy, no
 * throwing across the seam.
 *
 * - `Required`: no daemon is running for this directory; user must `up`.
 * - `Timeout`: the per-call AbortSignal fired before the daemon answered.
 * - `Unreachable`: socket missing, ECONNREFUSED, transport closed.
 * - `HandlerCrashed`: the daemon answered, but with a non-2xx status or
 *   the route's blanket try/catch surfaced a SerializedError envelope.
 *   Reserved for unexpected exceptions; typed domain errors flow through
 *   the inner Result instead.
 */
export const DaemonError = defineErrors({
	Required: ({ absDir }: { absDir: string }) => ({
		message: `no daemon running for ${absDir}; start one with \`epicenter up\` first`,
		absDir,
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
	Unreachable: ({
		socketPath,
		cause,
	}: {
		socketPath: string;
		cause: unknown;
	}) => ({
		message: `daemon connection failed at ${socketPath}: ${extractErrorMessage(cause)}`,
		socketPath,
		cause,
	}),
	HandlerCrashed: ({
		socketPath,
		cause,
	}: {
		socketPath: string;
		cause: unknown;
	}) => ({
		message: `daemon handler error at ${socketPath}: ${extractErrorMessage(cause)}`,
		socketPath,
		cause,
	}),
});
export type DaemonError = InferErrors<typeof DaemonError>;

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
 * Map one route call's `Promise<Response>` onto a single-level
 * `Result<T, DaemonError>`. Connect failures and timeouts become
 * `Timeout`/`Unreachable`; non-200 responses become `HandlerCrashed`. The
 * caller's body type `T` is the parsed JSON shape, including any inner
 * `Result` envelope (the wrapper methods unwrap that).
 */
async function callRoute<T>(
	socketPath: string,
	timeoutMs: number,
	pending: Promise<Response>,
): Promise<Result<T, DaemonError>> {
	try {
		const res = await pending;
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			return DaemonError.HandlerCrashed({
				socketPath,
				cause: body || `HTTP ${res.status}`,
			});
		}
		return { data: (await res.json()) as T, error: null };
	} catch (cause) {
		if (cause instanceof Error && cause.name === 'TimeoutError') {
			return DaemonError.Timeout({ socketPath, timeoutMs });
		}
		return DaemonError.Unreachable({ socketPath, cause });
	}
}

/**
 * Build a typed client for a daemon listening on `socketPath`. The returned
 * methods are derived from {@link DaemonApp} via `hc<DaemonApp>`, so call
 * sites get input-shape checking and inferred return types without
 * redeclaring the contracts.
 *
 * Each method returns `Promise<Result<Success, DomainErr | DaemonError>>`.
 * The renderer narrows `error.name` across both unions; no second `if`
 * needed at the call site.
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

	// Two-level wire: an outer envelope `Result<T, SerializedError>` that the
	// route handlers' blanket try/catch produces, plus (for /list and /run) a
	// nested domain `Result<Success, DomainErr>` inside `T`. This helper
	// flattens the outer envelope: SerializedError on the envelope means a
	// route handler crashed, surfaced as DaemonError.HandlerCrashed.
	const unwrap = <T>(
		envelope: Result<T, SerializedError>,
	): Result<T, DaemonError> => {
		if (envelope.error)
			return DaemonError.HandlerCrashed({
				socketPath,
				cause: envelope.error.message,
			});
		return { data: envelope.data, error: null };
	};

	return {
		ping: async (): Promise<Result<'pong', DaemonError>> => {
			const transport = await callRoute<Result<'pong', SerializedError>>(
				socketPath,
				timeoutMs,
				client.ping.$post(),
			);
			if (transport.error) return transport;
			return unwrap(transport.data);
		},

		peers: async (args: {
			workspace?: string;
		}): Promise<Result<PeerSnapshot[], DaemonError>> => {
			const transport = await callRoute<
				Result<PeerSnapshot[], SerializedError>
			>(socketPath, timeoutMs, client.peers.$post({ json: args }));
			if (transport.error) return transport;
			return unwrap(transport.data);
		},

		list: async (
			args: Parameters<typeof client.list.$post>[0]['json'],
		): Promise<
			Result<
				import('../commands/list.js').ListSuccess,
				import('../commands/list.js').ListError | DaemonError
			>
		> => {
			const transport = await callRoute<
				Result<import('../commands/list.js').ListResult, SerializedError>
			>(socketPath, timeoutMs, client.list.$post({ json: args }));
			if (transport.error) return transport;
			const env = unwrap(transport.data);
			if (env.error) return env;
			return env.data;
		},

		run: async (
			args: Parameters<typeof client.run.$post>[0]['json'],
		): Promise<
			Result<
				import('../commands/run.js').RunSuccess,
				import('../commands/run.js').RunError | DaemonError
			>
		> => {
			const transport = await callRoute<
				Result<import('../commands/run.js').RunResult, SerializedError>
			>(socketPath, timeoutMs, client.run.$post({ json: args }));
			if (transport.error) return transport;
			const env = unwrap(transport.data);
			if (env.error) return env;
			return env.data;
		},

		shutdown: async (): Promise<Result<null, DaemonError>> => {
			const transport = await callRoute<Result<null, SerializedError>>(
				socketPath,
				timeoutMs,
				client.shutdown.$post(),
			);
			if (transport.error) return transport;
			return unwrap(transport.data);
		},
	};
}

/**
 * Public type of the typed daemon handle. Equivalent to the return of
 * {@link daemonClient}.
 */
export type DaemonClient = ReturnType<typeof daemonClient>;

/**
 * Single dispatch decision for sibling commands. Pings the socket; if a
 * daemon answers, returns a typed {@link DaemonClient}. If no daemon is
 * alive, returns `null` and the caller falls through to its in-process
 * transient path.
 */
export async function tryGetDaemon(
	target: ResolvedTarget,
): Promise<DaemonClient | null> {
	const sock = socketPathFor(target.absDir);
	if (!(await pingDaemon(sock))) return null;
	return daemonClient(sock);
}
