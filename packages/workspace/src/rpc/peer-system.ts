/**
 * `peerSystem(sync, deviceId)` — typed proxy for runtime-injected `system.*`
 * meta operations on a remote peer.
 *
 * Kept separate from `peer<T>(sync, deviceId)` so the user-facing typed
 * action surface (`TActions`) stays free of infrastructure noise. Mirrors
 * `peer.ts`'s peer-resolution and peer-removed race semantics: if the
 * matched peer disappears mid-call, the in-flight Promise resolves
 * immediately with `RpcError.PeerLeft` rather than waiting for timeout.
 *
 * @example
 * ```ts
 * import { peerSystem } from '@epicenter/workspace';
 *
 * const result = await peerSystem(fuji.sync, 'macbook-pro').describe();
 * if (result.error) toast.error(extractErrorMessage(result.error));
 * else for (const [path, meta] of Object.entries(result.data)) { ... }
 * ```
 */

import { RpcError } from '@epicenter/sync';
import { Err, Ok, isResult, type Result } from 'wellcrafted/result';
import type { SyncAttachment } from '../document/attach-sync.js';
import type { ActionManifest } from '../shared/actions.js';

export type PeerSystem = {
	describe(): Promise<Result<ActionManifest, RpcError>>;
};

export function peerSystem(
	sync: SyncAttachment,
	deviceId: string,
): PeerSystem {
	return {
		describe() {
			const found = sync.find(deviceId);
			if (!found) {
				return Promise.resolve(
					Err(RpcError.PeerNotFound({ peer: deviceId }).error),
				);
			}

			return new Promise<Result<ActionManifest, RpcError>>((resolveCall) => {
				let settled = false;
				const settle = (v: Result<ActionManifest, RpcError>) => {
					if (settled) return;
					settled = true;
					unsubscribe();
					resolveCall(v);
				};
				const unsubscribe = sync.observe(() => {
					if (!sync.find(deviceId)) {
						settle(Err(RpcError.PeerLeft({ peer: deviceId }).error));
					}
				});

				sync
					.rpc(found.clientId, 'system.describe', undefined)
					.then((res) =>
						settle(
							isResult(res)
								? (res as Result<ActionManifest, RpcError>)
								: Ok(res as ActionManifest),
						),
					)
					.catch((cause) =>
						settle(
							Err(
								RpcError.ActionFailed({ action: 'system.describe', cause })
									.error,
							),
						),
					);
			});
		},
	};
}
