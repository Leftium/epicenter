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
 * - {@link getDaemon}: dispatch decision for `run` / `list` / `peers`.
 *   Returns a typed client on success, or `MissingConfig` /
 *   `Required` when the workspace isn't configured / has no live daemon.
 *
 * Wire format and security model are deliberately internal; see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol".
 */

import { join } from 'node:path';

import { hc } from 'hono/client';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import type { ActionManifest } from '@epicenter/workspace';

import type { RunError } from '../commands/run.js';
import { CONFIG_FILENAME } from '../load-config.js';
import type { ResolvedTarget } from '../util/common-options.js';
import type { ResolveError } from '../util/resolve-entry.js';
import type { DaemonApp, PeerSnapshot } from './app.js';
import { socketPathFor } from './paths.js';

/**
 * Tagged-error variants returned by daemon client surfaces. Domain errors
 * (UsageError, PeerMiss, etc.) live alongside these in a merged union so
 * call sites narrow once on `result.error.name`. No class hierarchy, no
 * throwing across the seam.
 *
 * - `Required`: no daemon is running for this directory; user must `up`.
 * - `Timeout`: the per-call AbortSignal fired before the daemon answered.
 * - `Unreachable`: socket missing, ECONNREFUSED, transport closed.
 * - `HandlerCrashed`: the daemon answered with a non-2xx status. Reserved
 *   for unexpected exceptions; typed domain errors flow through the body
 *   `Result` instead.
 */
export const DaemonError = defineErrors({
	MissingConfig: ({ absDir }: { absDir: string }) => ({
		message: `No ${CONFIG_FILENAME} found in ${absDir}`,
		absDir,
	}),
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
 * Make one route call and merge transport + domain errors into one union.
 *
 * Every route's body is `Result<T, E>` (with `E = never` for routes that
 * have no domain failures). On success, that body is the return value
 * directly: success/Err narrowing happens once at the call site. On
 * transport-plane failures (connect / timeout / non-2xx), we synthesize
 * the matching `DaemonError` variant and return it in the same union.
 */
async function callRoute<T, E>(
	socketPath: string,
	timeoutMs: number,
	pending: Promise<Response>,
): Promise<Result<T, E | DaemonError>> {
	try {
		const res = await pending;
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			return DaemonError.HandlerCrashed({
				socketPath,
				cause: body || `HTTP ${res.status}`,
			});
		}
		return (await res.json()) as Result<T, E>;
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

	return {
		peers: (args: { workspace?: string }) =>
			callRoute<PeerSnapshot[], never>(
				socketPath,
				timeoutMs,
				client.peers.$post({ json: args }),
			),

		list: (args: Parameters<typeof client.list.$post>[0]['json']) =>
			callRoute<ActionManifest, ResolveError>(
				socketPath,
				timeoutMs,
				client.list.$post({ json: args }),
			),

		run: (args: Parameters<typeof client.run.$post>[0]['json']) =>
			callRoute<unknown, RunError | ResolveError>(
				socketPath,
				timeoutMs,
				client.run.$post({ json: args }),
			),

		shutdown: () =>
			callRoute<null, never>(socketPath, timeoutMs, client.shutdown.$post()),
	};
}

/**
 * Public type of the typed daemon handle. Equivalent to the return of
 * {@link daemonClient}.
 */
export type DaemonClient = ReturnType<typeof daemonClient>;

/**
 * Resolve the daemon client for `target`, or surface why we can't.
 *
 *   - `MissingConfig`: no `epicenter.config.ts` in `absDir`. Surfaced
 *     distinctly from `Required` so unconfigured users don't get pointed
 *     at `epicenter up` (which would fail and mislead).
 *   - `Required`: config exists but no daemon is running. Renderer
 *     prints the start-with-`up` hint.
 *
 * `run`, `list`, and `peers` are mandatory-daemon commands; if they hit
 * neither variant they have a typed client to dispatch against.
 */
export async function getDaemon(
	target: ResolvedTarget,
): Promise<Result<DaemonClient, DaemonError>> {
	const configPath = join(target.absDir, CONFIG_FILENAME);
	if (!(await Bun.file(configPath).exists())) {
		return DaemonError.MissingConfig({ absDir: target.absDir });
	}
	const sock = socketPathFor(target.absDir);
	if (!(await pingDaemon(sock))) {
		return DaemonError.Required({ absDir: target.absDir });
	}
	return Ok(daemonClient(sock));
}
