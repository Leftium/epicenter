/**
 * Read peer awareness state off a loaded workspace. Filters self and any
 * non-object slots; returns opaque per-peer state for callers that don't
 * know the user's awareness schema.
 *
 * For awareness invariants (~30s TTL, session-local clientID, no field-name
 * convention), see `attachAwareness` in `@epicenter/workspace`.
 */

import type { LoadedWorkspace } from '../load-config';

/** Per-peer state as the CLI sees it — opaque string-keyed values. */
export type AwarenessState = Record<string, unknown>;

export function readPeers(
	workspace: LoadedWorkspace,
): Map<number, AwarenessState> {
	const awareness = workspace.awareness;
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
