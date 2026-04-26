/**
 * Typed projections over an awareness state. The `device` field is
 * convention-shaped (see `PeerDevice` in
 * `@epicenter/workspace/standard-awareness-defs`) — apps that opt in via
 * `standardAwarenessDefs` publish this exact shape, validated by arktype
 * at the boundary. Here we only narrow for TypeScript without
 * re-validating: a peer that publishes a malformed state is a publishing
 * bug, not a CLI concern.
 *
 * Two readers atop the one cast:
 *   - `readDevice` for presence (id / name / platform).
 *   - `readOffers` for the published action manifest.
 */

import type { ActionManifest, PeerDevice } from '@epicenter/workspace';
import type { AwarenessState } from './awareness';

function asDevice(state: AwarenessState): PeerDevice | undefined {
	return state.device as PeerDevice | undefined;
}

/** Presence fields from a peer awareness state. `undefined` = no `device` published yet. */
export function readDevice(state: AwarenessState): PeerDevice | undefined {
	return asDevice(state);
}

/** Published action manifest from a peer awareness state. Empty when none. */
export function readOffers(state: AwarenessState): ActionManifest {
	return asDevice(state)?.offers ?? {};
}
