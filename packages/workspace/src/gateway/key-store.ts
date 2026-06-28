/**
 * Persist a peer's iroh `SecretKey` to a `0600` JSON file so its `EndpointId`
 * (= public key) is stable across process restarts.
 *
 * This is the device's durable identity: the same keyfile always yields the
 * same `PeerId`, which is what makes "nodeId = iroh key" survive a restart and
 * what the Ring-0 allowlist keys on. Wave 2 wires this to the daemon's identity
 * path (`daemon-node-id.ts`); the gateway itself stays agnostic about where the
 * key lives by taking a `SecretKey` directly.
 *
 * Lifted from the proven `proto/super-chat-gateway-iroh` prototype.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SecretKey } from '@number0/iroh';

type KeyFile = { bytes: number[] };

/**
 * Load the `SecretKey` from `path` if the file exists, otherwise generate a
 * fresh key, persist it at `path` with mode `0600`, and return it.
 */
export function loadOrCreateDeviceSecret(path: string): SecretKey {
	if (existsSync(path)) {
		const data = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
		return SecretKey.fromBytes(data.bytes);
	}
	const secret = SecretKey.generate();
	const data: KeyFile = { bytes: [...secret.toBytes()] };
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
	return secret;
}
