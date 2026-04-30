/**
 * Daemon-side dispatch for the `/run` route. The Hono handler in `app.ts`
 * forwards to `executeRun` here.
 *
 * `epicenter run` is a shell shortcut for one workspace primitive:
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
import { invokeAction, resolveActionPath } from '../shared/actions.js';
import {
	resolveWorkspaceActionTarget,
	workspaceActionNearestSiblingLines,
	workspaceActionSuggestionLines,
} from './action-routing.js';
import type { RunRequest } from './app.js';
import { RunError, type RunResponse } from './run-errors.js';
import type { WorkspaceEntry } from './types.js';

export async function executeRun(
	entries: WorkspaceEntry[],
	{ actionPath, input: actionInput, peerTarget, waitMs }: RunRequest,
): Promise<RunResponse> {
	const target = resolveWorkspaceActionTarget(entries, actionPath);
	if (target.error !== null) {
		return RunError.UsageError({
			message: `No daemon route "${target.error.routeName}". Available: ${target.error.available.join(', ')}`,
			suggestions: target.error.available.map((name) => `  ${name}`),
		});
	}

	const { entry, localPath } = target.data;
	const { workspace } = entry;

	const action = resolveActionPath(workspace.actions, localPath);
	if (!action) {
		const descendants = workspaceActionSuggestionLines(entry, localPath);
		if (descendants.length > 0) {
			return RunError.UsageError({
				message: `"${actionPath}" is not a runnable action.`,
				suggestions: descendants,
			});
		}
		return RunError.UsageError({
			message: `"${actionPath}" is not defined.`,
			suggestions: workspaceActionNearestSiblingLines(entry, localPath),
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

async function invokeRemote({
	actionInput,
	entry,
	localPath,
	peerTarget,
	waitMs,
}: {
	actionInput: unknown;
	entry: WorkspaceEntry;
	localPath: string;
	peerTarget: string;
	waitMs: number;
}): Promise<RunResponse> {
	const { workspace } = entry;
	const presence = workspace.presence;
	const rpc = workspace.rpc;

	if (!presence || !rpc) {
		return RunError.UsageError({
			message: `Workspace "${entry.route}" has no peer RPC attachment; --peer requires presence and RPC.`,
		});
	}

	const start = Date.now();
	const found = await presence.waitForPeer(peerTarget, {
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
	const result = await rpc.rpc(targetClientId, localPath, actionInput, {
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
