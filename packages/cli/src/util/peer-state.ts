/**
 * Typed projections over an awareness state. The `device` field is
 * convention-shaped (see `PeerDevice` in
 * `@epicenter/workspace/standard-awareness-defs`) — apps that opt in via
 * `standardAwarenessDefs` publish this exact shape, validated by arktype
 * at the boundary. Here we expose the typed reads for ergonomic call
 * sites; consumers can also access `state.device` directly.
 *
 * Two readers:
 *   - `readDevice` for presence (id / name / platform).
 *   - `readOffers` for the published action manifest.
 */

import type { ActionManifest, PeerDevice } from '@epicenter/workspace';
import type { AwarenessState } from './awareness';

/** Presence fields from a peer awareness state. `undefined` = no `device` published yet. */
export function readDevice(state: AwarenessState): PeerDevice | undefined {
	return state.device;
}

/** Published action manifest from a peer awareness state. Empty when none. */
export function readOffers(state: AwarenessState): ActionManifest {
	return state.device?.offers ?? {};
}
