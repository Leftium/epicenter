/**
 * Daemon-side dispatch for the `/run` route. The Hono handler in `app.ts`
 * forwards to `executeRun` here.
 *
 * `epicenter run` is a shell shortcut for one daemon runtime primitive:
 *
 *   request.peerTarget === undefined   ->  invokeAction(...)
 *   request.peerTarget === <peerId>    ->  rpc.rpc(clientID, path, input)
 *
 * Power-user automation (loops, fan-out across peers, conditional dispatch)
 * lives in vault-style TypeScript scripts that load the workspace library
 * directly. The CLI deliberately does not grow flags that shadow scripting.
 *
 * `executeRun` returns a domain `RunResponse` that the route serializes
 * verbatim. Unexpected exceptions bubble to Hono's non-2xx response path
 * and surface as `HandlerCrashed` on the client side.
 */

import { Ok } from 'wellcrafted/result';
import {
	invokeAction,
	resolveActionPath,
	walkActions,
} from '../shared/actions.js';
import type { RunRequest } from './app.js';
import { RunError, type RunResponse } from './run-errors.js';
import type { DaemonRouteRuntime } from './types.js';

type DaemonActionTarget = {
	entry: DaemonRouteRuntime;
	localPath: string;
};

type DaemonRouteError = {
	routeName: string;
	available: string[];
};

export async function executeRun(
	runtimes: DaemonRouteRuntime[],
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
	const { runtime } = entry;

	const action = resolveActionPath(runtime.actions, localPath);
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

	const result = await invokeAction(action, actionInput, actionPath);
	if (result.error !== null) {
		return RunError.RuntimeError({ cause: result.error });
	}
	return Ok(result.data);
}

function resolveDaemonActionTarget(
	runtimes: DaemonRouteRuntime[],
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
	entry: DaemonRouteRuntime;
	localPath: string;
	peerTarget: string;
	waitMs: number;
}): Promise<RunResponse> {
	const { runtime } = entry;

	const start = Date.now();
	const found = await runtime.presence.waitForPeer(peerTarget, {
		timeoutMs: waitMs,
	});
	if (found.error !== null) {
		return RunError.PeerMiss({
			peerTarget: found.error.peerTarget,
			sawPeers: found.error.sawPeers,
			waitMs: found.error.waitMs,
			emptyReason: found.error.emptyReason,
		});
	}

	const { clientId: targetClientId, state: peerState } = found.data;
	const remaining = Math.max(1, waitMs - (Date.now() - start));
	const result = await runtime.rpc.rpc(targetClientId, localPath, actionInput, {
		timeout: remaining,
	});

	if (result.error !== null) {
		return RunError.RpcError({
			cause: result.error,
			targetClientId,
			peerState,
		});
	}
	return Ok(result.data);
}

function toDaemonActionPath(
	entry: DaemonRouteRuntime,
	localPath: string,
): string {
	return localPath ? `${entry.route}.${localPath}` : entry.route;
}

function daemonActionSuggestionLines(
	entry: DaemonRouteRuntime,
	prefix: string,
): string[] {
	const entries = [...walkActions(entry.runtime.actions)];
	const descendants = entriesUnder(entries, prefix);
	return descendants.map(
		([path, action]) =>
			`  ${toDaemonActionPath(entry, path)}  (${action.type})`,
	);
}

function daemonActionNearestSiblingLines(
	entry: DaemonRouteRuntime,
	missedPath: string,
): string[] {
	const entries = [...walkActions(entry.runtime.actions)];
	const parts = missedPath.split('.');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('.');
		const alts = entriesUnder(entries, prefix);
		if (alts.length === 0) continue;
		return alts.map(
			([path, action]) =>
				`  ${toDaemonActionPath(entry, path)}  (${action.type})`,
		);
	}
	return [];
}

function entriesUnder<TValue>(
	entries: Array<[string, TValue]>,
	prefix: string,
): Array<[string, TValue]> {
	if (!prefix) return entries;
	const pfx = `${prefix}.`;
	return entries.filter(([path]) => path === prefix || path.startsWith(pfx));
}
