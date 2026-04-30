/**
 * `createRemoteActions<T>(sync, deviceId)`: typed action proxy for one remote
 * device.
 *
 * The public API for cross-device action calls. It returns a JavaScript Proxy
 * whose method calls dispatch over `sync.rpc(...)`. Each leaf is
 * `(input?, options?) => Promise<Result<T, RpcError>>`.
 *
 * The proxy is stateless: every call resolves the deviceId against the
 * workspace's peers, using the first matching clientId in ascending order,
 * then dispatches via `sync.rpc`. If the matched device disappears mid-call,
 * the in-flight Promise resolves with `RpcError.PeerLeft` instead of waiting
 * for the timeout.
 *
 * `T` is the source object whose action leaves you want to expose remotely.
 * Pass `typeof openTabManager` (full bundle), a pure action tree, or any
 * object: `RemoteActionProxy<T>` filters non-action keys at the type level.
 *
 * @example
 * ```ts
 * import { createRemoteActions } from '@epicenter/workspace';
 *
 * const macbook = createRemoteActions<typeof tabManager>(fuji.sync, 'macbook-pro');
 * const result = await macbook.tabs.close({ tabIds: [1, 2] }, { timeout: 5_000 });
 * if (result.error) toast.error(extractErrorMessage(result.error));
 * else toast.success(`closed ${result.data.closedCount} tabs`);
 * ```
 */

import { RpcError } from '@epicenter/sync';
import type { Result } from 'wellcrafted/result';
import { Err } from 'wellcrafted/result';
import type { SyncAttachment } from '../document/attach-sync.js';
import type {
	ActionManifest,
	RemoteActionProxy,
	RemoteCallOptions,
	SystemActions,
} from '../shared/actions.js';

/**
 * Build a typed remote action proxy for `deviceId`. Each leaf dispatches via
 * `sync.rpc` and returns `Promise<Result<T, RpcError>>`.
 *
 * Takes a `SyncAttachment` directly: sync owns peer discovery (`find`,
 * `observe`) since it's the source of truth for who's connected. Pass the
 * workspace bundle's `sync` field, e.g.
 * `createRemoteActions<typeof fuji>(fuji.sync, 'mac')`.
 */
export function createRemoteActions<T>(
	sync: SyncAttachment,
	deviceId: string,
): RemoteActionProxy<T> {
	const send: Sender = async (path, input, options) => {
		const found = sync.find(deviceId);
		if (!found) return Err(RpcError.PeerNotFound({ peer: deviceId }).error);

		// Race the rpc against a peer-removed signal. If the matched peer
		// disappears mid-call, resolve immediately instead of waiting.
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
				.then(settle)
				.catch((cause) =>
					settle(Err(RpcError.ActionFailed({ action: path, cause }).error)),
				);
		});
	};

	return buildProxy<RemoteActionProxy<T>>([], send);
}

type Sender = (
	path: string,
	input: unknown,
	options?: RemoteCallOptions,
) => Promise<Result<unknown, RpcError>>;

/**
 * Fetch a remote device's full action manifest via the runtime-injected
 * `system.describe` RPC. Returns the same `ActionManifest` shape the local
 * `describeActions` walker produces, with live `input` schemas retained.
 *
 * Thin wrapper around {@link createRemoteActions}: inherits its peer-resolution and
 * peer-removed race semantics.
 *
 * @example
 * ```ts
 * const result = await describeRemoteActions(workspace.sync, 'macbook-pro');
 * if (result.error) toast.error(extractErrorMessage(result.error));
 * else for (const [path, meta] of Object.entries(result.data)) { ... }
 * ```
 */
export function describeRemoteActions(
	sync: SyncAttachment,
	deviceId: string,
): Promise<Result<ActionManifest, RpcError>> {
	return createRemoteActions<{ system: SystemActions }>(
		sync,
		deviceId,
	).system.describe();
}

/**
 * Recursive Proxy: walking `proxy.tabs.close` returns nested proxies; calling
 * `proxy.tabs.close({...})` invokes `send('tabs.close', {...})`. The runtime
 * value is wrapped in a no-op function so `apply` works on any property path.
 */
function buildProxy<T>(path: string[], send: Sender): T {
	const target = (() => {
		// no-op runtime body; only `apply` is used
	}) as unknown as object;
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
