/**
 * Presence wire protocol: the relay-owned device list, plus the one frame the
 * device sends to publish its own manifest.
 *
 * The relay owns presence (its `connections` map is the source of truth) and
 * broadcasts the FULL device list on every membership or manifest change. The
 * client stores the latest list verbatim: there is no delta protocol and no
 * client-side reassembly, the frame IS the state.
 *
 * The wire carries each device's full action manifest so the receiver can
 * render affordances, validate input schemas, or hand the manifest to an AI
 * tool layer with no second round trip. Manifests are opaque to the relay: it
 * stores and forwards them as bytes, never inspects their shape.
 *
 * Shared by the relay (`packages/server/src/room/core.ts`, the sender) and
 * the client (`open-collaboration.ts`, the reader). Pure types, zero runtime.
 */

import type { ActionManifest } from '../shared/actions.js';

/**
 * One device's entry on the wire.
 *
 * `installationId` routes dispatches; `connectedAt` lets receivers render an
 * "online since" affordance; `actions` is the device's published manifest, or
 * `{}` if the device has not (yet) published one. The same `ActionManifest`
 * type the local registry produces via `toActionMeta` is the wire form.
 */
export type PresenceDevice = {
	installationId: string;
	connectedAt: number;
	actions: ActionManifest;
};

/**
 * Server -> client: full set of currently-connected devices, pushed on every
 * membership or manifest change. `devices` always excludes the receiver's
 * own install: the relay computes the list per-recipient so the client never
 * has to filter self.
 */
export type PresenceFrame = {
	type: 'presence';
	devices: PresenceDevice[];
};

/**
 * Client -> server: publish this device's action manifest. The relay stores
 * the manifest against the sending socket's installationId and rebroadcasts
 * presence so peers see the update. Sent once on connect; re-sent if the
 * local action registry changes.
 */
export type PresencePublishFrame = {
	type: 'presence_publish';
	actions: ActionManifest;
};
