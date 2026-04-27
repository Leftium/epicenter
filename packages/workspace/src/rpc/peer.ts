/**
 * `peer<T>(workspace, deviceId)` — typed remote-action proxy for one peer.
 *
 * The single public API for cross-device action dispatch. Returns a JavaScript
 * Proxy whose method calls dispatch over the workspace's existing
 * `sync.rpc(...)` channel. Each leaf is `(input?, options?) => Promise<Result<T, E | RpcError>>`.
 *
 * The proxy is stateless — every call resolves the deviceId against the
 * workspace's `peers` (first-match in clientId-ascending order) and
 * dispatches via `sync.rpc`. If the matched peer disappears mid-call, the
 * in-flight Promise rejects immediately with `RpcError.PeerLeft` rather
 * than waiting for the timeout.
 *
 * Per-installation deviceId convention (see `getOrCreateDeviceId`) makes
 * first-match-wins safe: same deviceId means same logical device means
 * interchangeable runtimes.
 *
 * @example
 * ```ts
 * import { peer } from '@epicenter/workspace';
 * import type { TabManagerActions } from '@epicenter/tab-manager';
 *
 * const macbook = peer<TabManagerActions>(fuji, 'macbook-pro');
 * const result = await macbook.tabs.close({ tabIds: [1, 2] }, { timeout: 5_000 });
 * if (result.error) toast.error(extractErrorMessage(result.error));
 * else toast.success(`closed ${result.data.closedCount} tabs`);
 * ```
 */

import { RpcError } from '@epicenter/sync';
import { type Result } from 'wellcrafted/result';
import { Err, Ok, isResult } from 'wellcrafted/result';
import type { SyncAttachment } from '../document/attach-sync.js';
import type {
	ActionManifest,
	Actions,
	RemoteActions,
	RemoteCallOptions,
	SystemActions,
} from '../shared/actions.js';

/**
 * Build a typed peer proxy for `deviceId`. Each leaf method dispatches via
 * `sync.rpc` and returns `Promise<Result<T, E | RpcError>>`.
 *
 * Takes a `SyncAttachment` directly — sync owns peer discovery (`find`,
 * `observe`) since it's the source of truth for who's connected. Pass the
 * workspace bundle's `sync` field, e.g. `peer<TActions>(fuji.sync, 'mac')`.
 */
export function peer<TActions extends Actions>(
	sync: SyncAttachment,
	deviceId: string,
): RemoteActions<TActions> {
	const send: Sender = async (path, input, options) => {
		const found = sync.find(deviceId);
		if (!found) return Err(RpcError.PeerNotFound({ peer: deviceId }).error);

		// Race the rpc against a peer-removed signal. If the matched peer
		// disappears mid-call, reject immediately — don't wait for the timeout.
		return new Promise<Result<unknown, RpcError>>((resolveCall) => {
			let settled = false;
			const settle = (v: Result<unknown, RpcError>) => {
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
				.rpc(found.clientId, path, input, options)
				.then((res) => settle(isResult(res) ? res : Ok(res)))
				.catch((cause) =>
					settle(Err(RpcError.ActionFailed({ action: path, cause }).error)),
				);
		});
	};

	return buildProxy<RemoteActions<TActions>>([], send);
}

type Sender = (
	path: string,
	input: unknown,
	options?: RemoteCallOptions,
) => Promise<Result<unknown, RpcError>>;

type SystemMeta = { system: SystemActions };

/**
 * Fetch a peer's full action manifest via the runtime-injected `system.describe`
 * RPC. Returns the same `ActionManifest` shape the local `describeActions` walker
 * produces, with live `input` schemas retained.
 *
 * Thin wrapper around {@link peer} — inherits its peer-resolution and
 * peer-removed race semantics.
 *
 * @example
 * ```ts
 * const result = await describePeer(workspace.sync, 'macbook-pro');
 * if (result.error) toast.error(extractErrorMessage(result.error));
 * else for (const [path, meta] of Object.entries(result.data)) { ... }
 * ```
 */
export function describePeer(
	sync: SyncAttachment,
	deviceId: string,
): Promise<Result<ActionManifest, RpcError>> {
	return peer<SystemMeta>(sync, deviceId).system.describe();
}

/**
 * Recursive Proxy: walking `proxy.tabs.close` returns nested proxies; calling
 * `proxy.tabs.close({...})` invokes `send('tabs.close', {...})`. The runtime
 * value is wrapped in a no-op function so `apply` works on any property path.
 */
function buildProxy<T>(path: string[], send: Sender): T {
	const target = function () {
		// no-op runtime body; only `apply` is used
	} as unknown as object;
	return new Proxy(target, {
		get(_t, prop) {
			if (typeof prop !== 'string') return undefined;
			return buildProxy([...path, prop], send);
		},
		apply(_t, _this, args: unknown[]) {
			const [input, options] = args as [unknown?, RemoteCallOptions?];
			return send(path.join('.'), input, options);
		},
	}) as T;
}
