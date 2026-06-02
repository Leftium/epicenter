/**
 * Daemon-side action handlers for `/invoke` and `/dispatch`.
 *
 * Local invoke and peer dispatch stay separate here because they have
 * different authorities:
 *
 *   /invoke   -> this daemon's action registry decides action existence.
 *   /dispatch -> the recipient peer decides action existence.
 *
 * Dispatch addresses devices by `deviceId` directly; the relay routes to the
 * most-recently-connected socket for that device. If the relay has no live
 * socket for the target, dispatch resolves with `RecipientOffline`, surfaced
 * here as `PeerNotFound`; any other dispatch error is forwarded under
 * `RemoteCallFailed`.
 *
 * Power-user automation (loops, fan-out across peers, conditional dispatch)
 * lives in vault-style TypeScript scripts that load the workspace library
 * directly. The CLI deliberately does not grow flags that shadow scripting.
 *
 * Each function returns a domain response that the route serializes verbatim.
 * Unexpected exceptions bubble to Hono's non-2xx response path and surface as
 * `HandlerCrashed` on the client side.
 */

import { Ok, type Result } from 'wellcrafted/result';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import { invokeAction, isActionInputError } from '../shared/actions.js';
import {
	InvokeError,
	PeerDispatchError,
	type PeerDispatchSyncStatus,
} from './action-errors.js';
import { joinDaemonActionPath, parseDaemonActionPath } from './action-path.js';
import type { InvokeRequest, PeerDispatchRequest } from './app.js';
import type { DaemonServedMount } from './types.js';

export async function executeInvoke(
	mounts: readonly DaemonServedMount[],
	{ actionPath, input: actionInput }: InvokeRequest,
): Promise<Result<unknown, InvokeError>> {
	const { mount, localPath } = parseDaemonActionPath(actionPath);
	const mountRuntime = mounts.find((candidate) => candidate.mount === mount);
	if (!mountRuntime) {
		const available = mounts.map((candidate) => candidate.mount);
		return InvokeError.UsageError({
			message: `No mount "${mount}". Available: ${available.join(', ')}`,
			suggestions: available.map((name) => `  ${name}`),
		});
	}

	const action = mountRuntime.runtime.collaboration.actions[localPath];
	if (!action) {
		const descendants = daemonActionSuggestionLines(mountRuntime, localPath);
		if (descendants.length > 0) {
			return InvokeError.UsageError({
				message: `"${actionPath}" is not a runnable action.`,
				suggestions: descendants,
			});
		}
		return InvokeError.UsageError({
			message: `"${actionPath}" is not defined.`,
			suggestions: daemonActionNearestSiblingLines(mountRuntime, localPath),
		});
	}

	const result = await invokeAction(action, actionInput);
	if (result.error !== null) {
		// Input that fails the action's declared schema is a caller mistake, not
		// a handler crash: surface it as a usage error (the same family as an
		// unknown action) so the CLI exits 1, not 2.
		if (isActionInputError(result.error)) {
			return InvokeError.UsageError({ message: result.error.message });
		}
		return InvokeError.RuntimeError({ cause: result.error });
	}
	return Ok(result.data);
}

export async function executeDispatch(
	mounts: readonly DaemonServedMount[],
	{ actionPath, input: actionInput, to, waitMs }: PeerDispatchRequest,
): Promise<Result<unknown, PeerDispatchError>> {
	if (!Number.isInteger(waitMs) || waitMs < 0) {
		return PeerDispatchError.UsageError({
			message: '`waitMs` must be a non-negative integer.',
		});
	}

	const { mount, localPath } = parseDaemonActionPath(actionPath);
	const mountRuntime = mounts.find((candidate) => candidate.mount === mount);
	if (!mountRuntime) {
		const available = mounts.map((candidate) => candidate.mount);
		return PeerDispatchError.UsageError({
			message: `No mount "${mount}". Available: ${available.join(', ')}`,
			suggestions: available.map((name) => `  ${name}`),
		});
	}

	const { runtime } = mountRuntime;

	const result = await runtime.collaboration.dispatch({
		to,
		action: localPath,
		input: actionInput,
		signal: AbortSignal.timeout(waitMs),
	});

	if (result.error !== null) {
		const syncStatus = toPeerDispatchSyncStatus(runtime.collaboration.status);
		switch (result.error.name) {
			case 'RecipientOffline':
				return PeerDispatchError.PeerNotFound({
					to,
					waitMs,
					syncStatus,
				});
			case 'ActionNotFound':
			case 'ActionFailed':
			case 'Cancelled':
			case 'NetworkFailed':
				return PeerDispatchError.RemoteCallFailed({
					cause: result.error,
					to,
					syncStatus,
				});
			default:
				return result.error satisfies never;
		}
	}
	return Ok(result.data);
}

function toPeerDispatchSyncStatus(status: SyncStatus): PeerDispatchSyncStatus {
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

function daemonActionSuggestionLines(
	mountRuntime: DaemonServedMount,
	prefix: string,
): string[] {
	return Object.entries(mountRuntime.runtime.collaboration.actions)
		.filter(([path]) => !prefix || path.startsWith(prefix))
		.map(
			([path, action]) =>
				`  ${joinDaemonActionPath(mountRuntime.mount, path)}  (${action.type})`,
		);
}

function daemonActionNearestSiblingLines(
	mountRuntime: DaemonServedMount,
	missedPath: string,
): string[] {
	const parts = missedPath.split('_');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('_');
		const alts = daemonActionSuggestionLines(mountRuntime, prefix);
		if (alts.length > 0) return alts;
	}
	return [];
}
