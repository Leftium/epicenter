/**
 * Read peer awareness state off a loaded workspace.
 *
 * Awareness invariants the CLI relies on (from y-protocols/awareness):
 *
 *   - **Ephemeral.** ~30s liveness window; peers that crashed silently
 *     disappear after `outdatedTimeout`. Awareness is a liveness probe,
 *     not a directory.
 *   - **clientID is session-local.** Re-randomized on every `new Y.Doc()`,
 *     so numeric clientIDs are stable within one presence session only.
 *   - **No field-name convention.** The CLI picks no default identity
 *     field. Bundles that want stable addressing across reconnects
 *     persist an identifier locally and publish it into awareness under
 *     whatever name they choose. Callers address it explicitly as
 *     `--peer <field>=<value>`.
 *
 * Workspaces may attach either the typed wrapper from `attachAwareness`
 * (which exposes `.raw`) or the raw `Awareness` directly. Both shapes
 * work — `unwrap` checks `.raw` first.
 */

import type { AwarenessLike, LoadedWorkspace } from '../load-config';

/** Per-peer state as the CLI sees it — opaque string-keyed values. */
export type AwarenessState = Record<string, unknown>;

export function readPeers(
	workspace: LoadedWorkspace,
): Map<number, AwarenessState> {
	const awareness = unwrap(workspace.awareness);
	if (!awareness) return new Map();
	const peers = new Map<number, AwarenessState>();
	const selfId = awareness.clientID;
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === selfId) continue;
		if (state == null || typeof state !== 'object') continue;
		peers.set(clientId, state as AwarenessState);
	}
	return peers;
}

function unwrap(
	awareness: LoadedWorkspace['awareness'],
): AwarenessLike | undefined {
	if (awareness == null) return undefined;
	if ('raw' in awareness && isAwareness(awareness.raw)) return awareness.raw;
	if (isAwareness(awareness)) return awareness;
	return undefined;
}

function isAwareness(value: unknown): value is AwarenessLike {
	return (
		value != null &&
		typeof value === 'object' &&
		typeof (value as { getStates?: unknown }).getStates === 'function' &&
		typeof (value as { clientID?: unknown }).clientID === 'number'
	);
}
