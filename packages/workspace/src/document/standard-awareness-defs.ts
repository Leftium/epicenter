/**
 * Standard awareness convention for cross-device action discovery.
 *
 * Each connected peer publishes a `device` object describing itself plus the
 * action manifest it offers. Other peers read awareness to discover what's
 * callable where, and dispatch via `peer<T>(workspace, deviceId)`.
 *
 * Apps opt in by spreading `standardAwarenessDefs` into their `attachAwareness`
 * call; app-specific fields can be added alongside:
 *
 * ```ts
 * const awareness = attachAwareness(ydoc, {
 *   ...standardAwarenessDefs,
 *   cursor: type({ x: 'number', y: 'number' }),  // app-specific field
 * });
 * awareness.setLocal({
 *   device: {
 *     id: getOrCreateDeviceId(localStorage),
 *     name: 'Braden MacBook',
 *     platform: 'web',
 *     offers: actionManifest(actions),
 *   },
 * });
 * ```
 */

import { type } from 'arktype';

/** Closed enum of supported platforms — extends as new app targets ship. */
export const Platform = type(
	'"web" | "tauri" | "chrome-extension" | "node"',
);
export type Platform = typeof Platform.infer;

/**
 * Single manifest entry for one action — wire-validation shape. Richer
 * TypeScript shape lives in `ActionMeta` (the same shape used locally).
 */
const ActionManifestEntrySchema = type({
	type: '"query" | "mutation"',
	'input?': 'object',
	'title?': 'string',
	'description?': 'string',
});

/**
 * The peer descriptor + offered actions, published by each connected peer.
 * `offers` is a flat map keyed by dot-path (e.g. `"entries.create"`).
 *
 * Named `PeerDevice` (not `Device`) so it doesn't collide with app-level
 * `Device` table-row types (e.g. tab-manager's devices table).
 */
export const PeerDevice = type({
	id: 'string',
	name: 'string',
	platform: Platform,
	offers: { '[string]': ActionManifestEntrySchema },
});
export type PeerDevice = typeof PeerDevice.infer;

/**
 * Input shape for workspace factories. The factory adds `offers` (computed
 * from the workspace's actions) before publishing into awareness, so app
 * code never assembles the offers map by hand.
 *
 * Generic over `TId` so apps with branded ID types (e.g. tab-manager's
 * `DeviceId`) can carry the brand through the factory without `as` casts.
 * Defaults to `string` — SPAs and untyped consumers see no difference.
 */
export type DeviceDescriptor<TId extends string = string> = {
	id: TId;
	name: string;
	platform: Platform;
};

/**
 * Spread into `attachAwareness` defs to enable typed access to the
 * `state.device` field on peer awareness states.
 */
export const standardAwarenessDefs = {
	device: PeerDevice,
};

/** A peer's awareness state under the standard `device` schema. */
export type PeerAwarenessState = { device: PeerDevice };

/** Result of a `find(deviceId)` lookup — clientId plus full peer state. */
export type FoundPeer = { clientId: number; state: PeerAwarenessState };
