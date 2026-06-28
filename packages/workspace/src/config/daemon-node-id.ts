/**
 * Resolve a daemon's durable node identity for one Epicenter root.
 *
 * The daemon's identity is its iroh device key: the same keypair file always
 * yields the same public key string, so a restart reuses the identity, two
 * folders on one machine get distinct ids (distinct key files, keyed by dir
 * hash), and two machines never collide (the key is generated randomly on
 * first boot). The key file lives under `runtimeDir()` (machine-local,
 * OUTSIDE the repo tree), not under `.epicenter/`, so it survives `git clean`
 * and is never accidentally committed.
 *
 * Browser app nodeIds (opensidian, fuji, honeycrisp, vocab, tab-manager) stay
 * nanoid-backed via `createNodeId`/`createNodeIdAsync` in
 * `document/node-id.ts`. This module only touches the daemon path.
 *
 * The relay routes by the `?nodeId=` query param, so using the iroh public key
 * as the nodeId publishes the daemon's iroh identity to any peer that observes
 * the presence frame — no schema change required.
 */

import { asNodeId, type NodeId } from '../document/node-id.js';
import { irohKeyPathFor } from '../daemon/paths.js';
import { loadOrCreateDeviceSecret } from '../gateway/key-store.js';

/**
 * Read or lazily generate the daemon's durable iroh node id for an Epicenter
 * root, persisting the secret key at `irohKeyPathFor(epicenterRoot)`.
 * Idempotent across restarts.
 */
export function resolveDaemonNodeId(epicenterRoot: string): NodeId {
	return asNodeId(
		loadOrCreateDeviceSecret(irohKeyPathFor(epicenterRoot)).public().toString(),
	);
}
