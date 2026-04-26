/**
 * Read peer awareness state off a loaded workspace. Thin wrapper around
 * the typed `Awareness` wrapper's `peers()` method (which already filters
 * self and validates against the awareness schema). Returns an empty map
 * when the workspace exposes no awareness.
 *
 * For awareness invariants (~30s TTL, session-local clientID, no field-name
 * convention), see `attachAwareness` in `@epicenter/workspace`.
 */

import type {
	AwarenessState as WorkspaceAwarenessState,
	standardAwarenessDefs,
} from '@epicenter/workspace';
import type { LoadedWorkspace } from '../load-config';

/** Per-peer state typed against `standardAwarenessDefs` (`{ device?: PeerDevice }`). */
export type AwarenessState = WorkspaceAwarenessState<
	typeof standardAwarenessDefs
>;

export function readPeers(
	workspace: LoadedWorkspace,
): Map<number, AwarenessState> {
	return workspace.awareness?.peers() ?? new Map();
}
