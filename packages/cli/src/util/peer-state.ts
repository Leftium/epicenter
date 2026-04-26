/**
 * Typed projections over an awareness state.
 *
 * Every CLI command that consumes peer awareness needs the same two
 * accessors: presence fields (`device.id` / `name` / `platform`) and the
 * action manifest (`device.offers`). Without these, every call site
 * repeats the same `state.device as { … }` cast — which has happened
 * four times so far across `list`, `peers`, and the error formatter.
 *
 * The runtime shape is enforced upstream by the arktype `PeerDevice`
 * schema in `@epicenter/workspace/standard-awareness-defs`. Here we only
 * narrow for TypeScript without re-validating — a peer that publishes a
 * malformed state is a publishing bug, not a CLI concern.
 */

import type { ActionManifest } from '@epicenter/workspace';
import type { AwarenessState } from './awareness';

export type PeerPresence = {
	id: string;
	name: string;
	platform: string;
};

/**
 * Read presence fields from an awareness state. Returns `undefined` when
 * the peer hasn't published a `device` yet (boot race) — callers should
 * treat that as "online but anonymous".
 */
export function readDevice(state: AwarenessState): PeerPresence | undefined {
	const device = state.device as
		| Partial<PeerPresence> & { offers?: ActionManifest }
		| undefined;
	if (!device) return undefined;
	return {
		id: device.id ?? '',
		name: device.name ?? '',
		platform: device.platform ?? '',
	};
}

/**
 * Read the published action manifest from an awareness state. Empty map
 * when the peer hasn't published offers (boot race, or an app that opts
 * out of publishing).
 */
export function readOffers(state: AwarenessState): ActionManifest {
	const offers = (state.device as { offers?: ActionManifest } | undefined)
		?.offers;
	return offers ?? {};
}
