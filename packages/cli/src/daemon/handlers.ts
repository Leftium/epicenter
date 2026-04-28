/**
 * Daemon-side action dispatch. The Hono `/list` and `/run` route handlers
 * in `app.ts` call these against an already-warm `WorkspaceEntry`.
 *
 * Each function returns a domain `Result` (`ListResult`, `RunResult`)
 * that the route serializes verbatim. Unexpected exceptions bubble out
 * to the route's blanket try/catch, which surfaces them as
 * `HandlerCrashed` on the client side.
 */

import {
	type Action,
	describeActions,
	describePeer,
	invokeAction,
	resolveActionPath,
	type SyncAttachment,
	walkActions,
} from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';

import {
	ListError,
	type ListResult,
	type Section,
} from '../commands/list.js';
import {
	RunError,
	type RunCtx,
	type RunResult,
} from '../commands/run.js';
import type { ListCtx } from './schemas.js';
import type {
	AwarenessState,
	WorkspaceEntry,
} from '../load-config.js';
import { explainEmpty, waitForAnyPeer, waitForPeer } from '../util/peer-wait.js';

export async function executeList(
	entry: WorkspaceEntry,
	ctx: ListCtx,
): Promise<ListResult> {
	const { workspace } = entry;
	const { mode, waitMs } = ctx;

	if (mode.kind === 'local') {
		return Ok({ sections: [selfSection(entry, 'local')], mode });
	}

	const deadline = Date.now() + waitMs;
	if (mode.kind === 'peer') {
		// `peerSection` needs the sync attachment for `describePeer`. If
		// the workspace has no sync, no peers can match: short-circuit to
		// PeerMiss with the standard empty-reason hint, no `!` needed.
		const sync = workspace.sync;
		if (!sync) {
			return ListError.PeerMiss({
				deviceId: mode.deviceId,
				emptyReason: explainEmpty(workspace),
			});
		}
		const { hit } = await waitForPeer(workspace, mode.deviceId, deadline);
		if (!hit) {
			return ListError.PeerMiss({
				deviceId: mode.deviceId,
				emptyReason: explainEmpty(workspace),
			});
		}
		return Ok({
			sections: [await peerSection(hit.state, sync)],
			mode,
		});
	}

	// --all
	await waitForAnyPeer(workspace, deadline);
	if (!workspace.sync) {
		return Ok({ sections: [selfSection(entry, 'all')], mode });
	}
	const ordered = [...workspace.sync.peers().entries()].sort(
		([a], [b]) => a - b,
	);
	const sections: Section[] = [selfSection(entry, 'all')];
	for (const [, state] of ordered) {
		sections.push(await peerSection(state, workspace.sync));
	}
	return Ok({ sections, mode });
}

export async function executeRun(
	entry: WorkspaceEntry,
	ctx: RunCtx,
): Promise<RunResult> {
	const { workspace } = entry;
	if (workspace.whenReady) await workspace.whenReady;

	const action = resolveActionPath(workspace.actions ?? {}, ctx.actionPath);
	if (!action) {
		const entries = [...walkActions(workspace.actions ?? {})];
		const descendants = entriesUnder(entries, ctx.actionPath);
		if (descendants.length > 0) {
			return RunError.UsageError({
				message: `"${ctx.actionPath}" is not a runnable action.`,
				suggestions: descendants.map(([p, a]) => `  ${p}  (${a.type})`),
			});
		}
		return RunError.UsageError({
			message: `"${ctx.actionPath}" is not defined.`,
			suggestions: nearestSiblingLines(entries, ctx.actionPath),
		});
	}

	if (ctx.peerTarget !== undefined) {
		return invokeRemote(entry, ctx);
	}

	const result = await invokeAction(action, ctx.input, ctx.actionPath);
	if (result.error !== null) {
		return RunError.RuntimeError({ cause: result.error });
	}
	return Ok({ data: result.data });
}

async function invokeRemote(
	entry: WorkspaceEntry,
	ctx: RunCtx,
): Promise<RunResult> {
	const { workspace } = entry;
	const sync = workspace.sync;

	if (!sync?.rpc) {
		return RunError.UsageError({
			message: `Workspace "${entry.name}" has no sync attachment; --peer requires sync.`,
		});
	}

	const deadline = Date.now() + ctx.waitMs;
	const { hit, sawPeers } = await waitForPeer(
		workspace,
		ctx.peerTarget!,
		deadline,
	);
	if (!hit) {
		return RunError.PeerMiss({
			peerTarget: ctx.peerTarget!,
			sawPeers,
			workspaceArg: ctx.workspaceArg,
			waitMs: ctx.waitMs,
			emptyReason: explainEmpty(workspace),
		});
	}

	const { clientID: targetClientId, state: peerState } = hit;
	const remaining = Math.max(1, deadline - Date.now());
	const result = await sync.rpc(targetClientId, ctx.actionPath, ctx.input, {
		timeout: remaining,
	});

	if (result.error !== null) {
		return RunError.RpcError({
			cause: result.error,
			targetClientId,
			peerState,
		});
	}
	return Ok({ data: result.data });
}

export function selfSection(entry: WorkspaceEntry, mode: 'local' | 'all'): Section {
	const localActions = entry.workspace.actions;
	const entries = localActions ? describeActions(localActions) : {};
	return {
		label: mode === 'all' ? 'self (this device)' : entry.name,
		peer: 'self',
		entries,
	};
}

export async function peerSection(
	state: AwarenessState,
	sync: SyncAttachment,
): Promise<Section> {
	const { device } = state;
	const { data: entries, error } = await describePeer(sync, device.id);
	if (error) {
		return {
			label: `${device.name} (online, schema unavailable)`,
			peer: device.id,
			entries: {},
			unavailableReason: extractErrorMessage(error),
		};
	}
	const suffix =
		Object.keys(entries).length === 0 ? ' (online, no actions)' : ' (online)';
	return {
		label: `${device.name}${suffix}`,
		peer: device.id,
		entries,
	};
}

function entriesUnder(
	entries: Array<[string, Action]>,
	prefix: string,
): Array<[string, Action]> {
	if (!prefix) return entries;
	const pfx = prefix + '.';
	return entries.filter(([p]) => p === prefix || p.startsWith(pfx));
}

function nearestSiblingLines(
	entries: Array<[string, Action]>,
	missedPath: string,
): string[] {
	const parts = missedPath.split('.');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('.');
		const alts = entriesUnder(entries, prefix);
		if (alts.length === 0) continue;
		return alts.map(([p, a]) => `  ${p}  (${a.type})`);
	}
	return [];
}
