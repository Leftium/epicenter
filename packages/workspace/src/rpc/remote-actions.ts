import { RpcError } from '@epicenter/sync';
import type { Result } from 'wellcrafted/result';
import { Err } from 'wellcrafted/result';
import type { PeerPresenceAttachment } from '../document/peer-presence.js';
import type { SyncRpcAttachment } from '../document/attach-sync.js';
import type {
	ActionManifest,
	RemoteActionProxy,
	RemoteCallOptions,
	SystemActions,
} from '../shared/actions.js';

export type RemoteActionTransport = {
	presence: PeerPresenceAttachment;
	rpc: SyncRpcAttachment;
};

export function createRemoteActions<T>(
	transport: RemoteActionTransport,
	peerId: string,
): RemoteActionProxy<T> {
	const send: Sender = async (path, input, options) => {
		const found = transport.presence.find(peerId);
		if (!found) return Err(RpcError.PeerNotFound({ peer: peerId }).error);

		return new Promise<Result<unknown, RpcError>>((resolveCall) => {
			let settled = false;
			const settle = (v: Result<unknown, RpcError>) => {
				if (settled) return;
				settled = true;
				unsubscribe();
				resolveCall(v);
			};
			const unsubscribe = transport.presence.observe(() => {
				if (!transport.presence.find(peerId)) {
					settle(Err(RpcError.PeerLeft({ peer: peerId }).error));
				}
			});

			if (!transport.presence.find(peerId)) {
				settle(Err(RpcError.PeerLeft({ peer: peerId }).error));
				return;
			}

			transport.rpc
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

export function describeRemoteActions(
	transport: RemoteActionTransport,
	peerId: string,
): Promise<Result<ActionManifest, RpcError>> {
	return createRemoteActions<{ system: SystemActions }>(
		transport,
		peerId,
	).system.describe();
}

function buildProxy<T>(path: string[], send: Sender): T {
	const target = (() => {}) as unknown as object;
	return new Proxy(target, {
		get(_t, prop) {
			if (typeof prop !== 'string') return undefined;
			if (prop === 'then') return undefined;
			return buildProxy([...path, prop], send);
		},
		apply(_t, _this, args: unknown[]) {
			const [input, options] = args as [unknown?, RemoteCallOptions?];
			return send(path.join('.'), input, options);
		},
	}) as T;
}
