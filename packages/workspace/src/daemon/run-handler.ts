/**
 * Daemon-side dispatch for the `/run` route. The Hono handler in `app.ts`
 * forwards to `executeRun` here.
 *
 * `epicenter run` is a shell shortcut for one daemon runtime primitive:
 *
 *   request.peerTarget === undefined   ->  invokeAction(...)
 *   request.peerTarget === <replicaId> ->  collab.peers.list().find((p) => p.replicaId === ...) -> collab.dispatch(...)
 *
 * Power-user automation (loops, fan-out across peers, conditional dispatch)
 * lives in vault-style TypeScript scripts that load the workspace library
 * directly. The CLI deliberately does not grow flags that shadow scripting.
 *
 * `executeRun` returns a domain `RunResponse` that the route serializes
 * verbatim. Unexpected exceptions bubble to Hono's non-2xx response path
 * and surface as `HandlerCrashed` on the client side.
 */

import { Ok, type Result } from 'wellcrafted/result';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { PresenceSurface } from '../document/presence.js';
import type { DispatchError } from '../document/rpc.js';
import type { ActionRegistry } from '../shared/actions.js';
import { invokeAction } from '../shared/actions.js';
import type { RunRequest } from './app.js';
import {
	RunError,
	type RunResponse,
	type RunSyncStatus,
} from './run-errors.js';

/**
 * The exact collaboration surface `/run` reads.
 *
 * This keeps `executeRun` as the single source of truth for peer dispatch
 * behavior while letting tests build narrow fixtures. Full daemon runtimes can
 * still pass through structurally, but tests no longer fake unrelated lifecycle
 * fields just to reach action lookup, presence lookup, and dispatch.
 */
export type DaemonRunCollaboration<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	actions: TActions;
	peers: Pick<PresenceSurface, 'list'>;
	status: SyncStatus;
	dispatch(
		action: string,
		input: unknown,
		options: { to: string; signal: AbortSignal },
	): Promise<Result<unknown, DispatchError>>;
};

/**
 * One daemon route as read by `/run`.
 *
 * The full `StartedDaemonRoute` remains the server lifecycle type. This type is
 * narrower on purpose: route selection, local invocation, and remote peer
 * dispatch all depend on this shape and no other daemon runtime fields.
 */
export type DaemonRunRoute<TActions extends ActionRegistry = ActionRegistry> = {
	route: string;
	runtime: {
		collaboration: DaemonRunCollaboration<TActions>;
	};
};

type DaemonActionTarget = {
	entry: DaemonRunRoute;
	localPath: string;
};

type DaemonRouteError = {
	routeName: string;
	available: string[];
};

export async function executeRun(
	runtimes: DaemonRunRoute[],
	{ actionPath, input: actionInput, peerTarget, waitMs }: RunRequest,
): Promise<RunResponse> {
	const target = resolveDaemonActionTarget(runtimes, actionPath);
	if (target.error !== null) {
		return RunError.UsageError({
			message: `No daemon route "${target.error.routeName}". Available: ${target.error.available.join(', ')}`,
			suggestions: target.error.available.map((name) => `  ${name}`),
		});
	}

	const { entry, localPath } = target.data;

	const action = entry.runtime.collaboration.actions[localPath];
	if (!action) {
		const descendants = daemonActionSuggestionLines(entry, localPath);
		if (descendants.length > 0) {
			return RunError.UsageError({
				message: `"${actionPath}" is not a runnable action.`,
				suggestions: descendants,
			});
		}
		return RunError.UsageError({
			message: `"${actionPath}" is not defined.`,
			suggestions: daemonActionNearestSiblingLines(entry, localPath),
		});
	}

	if (peerTarget !== undefined) {
		return invokeRemote({
			actionInput,
			entry,
			localPath,
			peerTarget,
			waitMs,
		});
	}

	const result = await invokeAction(action, actionInput);
	if (result.error !== null) {
		return RunError.RuntimeError({ cause: result.error });
	}
	return Ok(result.data);
}

function resolveDaemonActionTarget(
	runtimes: DaemonRunRoute[],
	actionPath: string,
):
	| { data: DaemonActionTarget; error: null }
	| { data: null; error: DaemonRouteError } {
	const [routeName = '', ...rest] = actionPath.split('.');
	const entry = runtimes.find((candidate) => candidate.route === routeName);
	if (!entry) {
		return {
			data: null,
			error: {
				routeName,
				available: runtimes.map((candidate) => candidate.route),
			},
		};
	}
	return {
		data: {
			entry,
			localPath: rest.join('.'),
		},
		error: null,
	};
}

async function invokeRemote({
	actionInput,
	entry,
	localPath,
	peerTarget,
	waitMs,
}: {
	actionInput: unknown;
	entry: DaemonRunRoute;
	localPath: string;
	peerTarget: string;
	waitMs: number;
}): Promise<RunResponse> {
	const { runtime } = entry;

	// `peerTarget` is a `replicaId` from the CLI; presence rows are keyed by
	// `connId`, so pick the first (lowest-`connId`) tab on that install.
	// `peers.list()` is already sorted by `connId` ascending, so `find` here
	// is deterministic without an extra sort.
	const peer = runtime.collaboration.peers
		.list()
		.find((p) => p.replicaId === peerTarget);
	if (!peer) {
		return RunError.PeerNotFound({
			peerTarget,
			waitMs,
			syncStatus: toRunSyncStatus(runtime.collaboration.status),
		});
	}

	const result = await runtime.collaboration.dispatch(localPath, actionInput, {
		to: peer.connId,
		signal: AbortSignal.timeout(waitMs),
	});

	if (result.error !== null) {
		return RunError.RemoteCallFailed({
			cause: result.error,
			peerTarget,
			syncStatus: toRunSyncStatus(runtime.collaboration.status),
		});
	}
	return Ok(result.data);
}

function toRunSyncStatus(status: SyncStatus): RunSyncStatus {
	switch (status.phase) {
		case 'offline':
			return { phase: 'offline' };
		case 'connected':
			return { phase: 'connected' };
		case 'connecting':
			return {
				phase: 'connecting',
				retries: status.retries,
				lastErrorType: status.lastError?.type,
			};
		case 'failed':
			return {
				phase: 'failed',
				reason: status.reason,
			};
		default:
			return status satisfies never;
	}
}

function toDaemonActionPath(
	entry: DaemonRunRoute,
	localPath: string,
): string {
	return localPath ? `${entry.route}.${localPath}` : entry.route;
}

function daemonActionSuggestionLines(
	entry: DaemonRunRoute,
	prefix: string,
): string[] {
	return Object.entries(entry.runtime.collaboration.actions)
		.filter(([path]) => !prefix || path.startsWith(prefix))
		.map(
			([path, action]) =>
				`  ${toDaemonActionPath(entry, path)}  (${action.type})`,
		);
}

function daemonActionNearestSiblingLines(
	entry: DaemonRunRoute,
	missedPath: string,
): string[] {
	const parts = missedPath.split('_');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('_');
		const alts = daemonActionSuggestionLines(entry, prefix);
		if (alts.length > 0) return alts;
	}
	return [];
}
