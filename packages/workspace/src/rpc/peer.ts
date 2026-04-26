/**
 * `peer<T>(workspace, deviceId)` — typed remote-action proxy for one peer.
 *
 * The single public API for cross-device action dispatch. Returns a JavaScript
 * Proxy whose method calls dispatch over the workspace's existing
 * `sync.rpc(...)` channel. Each leaf is `(input?, options?) => Promise<Result<T, E | RpcError>>`.
 *
 * The proxy is stateless — every call resolves the deviceId against the
 * workspace's awareness (first-match in clientId-ascending order) and
 * dispatches via `sync.rpc`. If the matched peer disappears from awareness
 * mid-call, the in-flight Promise rejects immediately with
 * `RpcError.PeerLeft` rather than waiting for the timeout.
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
import type { Awareness as YAwareness } from 'y-protocols/awareness';
import { type Result } from 'wellcrafted/result';
import { Err, Ok, isResult } from 'wellcrafted/result';
import type { SyncAttachment } from '../document/attach-sync.js';
import type {
	Actions,
	RemoteActions,
	RemoteCallOptions,
} from '../shared/actions.js';

/**
 * Workspace shape required by `peer()`. Duck-typed so any workspace exposing
 * `awareness.raw` (a `y-protocols/awareness` instance) and `sync.rpc` conforms
 * without ceremony. The `rpc` shape is narrowed via `Pick` so the signature
 * stays in lockstep with `attachSync`'s real surface — no inline duplication
 * to drift.
 */
export type PeerWorkspace = {
	awareness: { raw: YAwareness };
	sync: Pick<SyncAttachment, 'rpc'>;
};

/**
 * Walk `awareness.getStates()` for the first peer publishing this deviceId,
 * in clientId-ascending order. Returns `Err(PeerNotFound)` if no match.
 *
 * The first-match-wins policy depends on the per-installation deviceId
 * convention: same deviceId means same logical device, so any runtime
 * publishing it can service the call.
 */
export function resolvePeer(
	awareness: YAwareness,
	deviceId: string,
): Result<number, RpcError> {
	const states = awareness.getStates();
	const clientIds = [...states.keys()].sort((a, b) => a - b);
	for (const clientId of clientIds) {
		const state = states.get(clientId) as
			| { device?: { id?: string } }
			| undefined;
		if (state?.device?.id === deviceId) return Ok(clientId);
	}
	return Err(RpcError.PeerNotFound({ peer: deviceId }).error);
}

/**
 * Build a typed peer proxy for `deviceId`. Each leaf method dispatches via
 * `workspace.sync.rpc` and returns `Promise<Result<T, E | RpcError>>`.
 */
export function peer<TActions extends Actions>(
	workspace: PeerWorkspace,
	deviceId: string,
): RemoteActions<TActions> {
	const send: Sender = async (path, input, options) => {
		const resolved = resolvePeer(workspace.awareness.raw, deviceId);
		if (resolved.error) return Err(resolved.error);

		// Race the rpc against an awareness-removed signal. If the matched peer
		// disappears mid-call, reject immediately — don't wait for the timeout.
		return new Promise<Result<unknown, RpcError>>((resolveCall) => {
			let settled = false;
			const settle = (v: Result<unknown, RpcError>) => {
				if (settled) return;
				settled = true;
				workspace.awareness.raw.off('change', onChange);
				resolveCall(v);
			};
			const onChange = () => {
				if (resolvePeer(workspace.awareness.raw, deviceId).error) {
					settle(Err(RpcError.PeerLeft({ peer: deviceId }).error));
				}
			};
			workspace.awareness.raw.on('change', onChange);

			workspace.sync
				.rpc(resolved.data, path, input, options)
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
