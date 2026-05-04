import { RpcError } from '@epicenter/sync';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { Err, Ok } from 'wellcrafted/result';
import type {
	AwarenessAttachment,
	AwarenessSchema,
} from '../document/attach-awareness.js';
import type { SyncRpcAttachment } from '../document/attach-sync.js';
import type {
	PeerAwarenessState,
	PeerIdentity,
	ResolvedPeer,
} from '../document/peer-identity.js';
import type {
	ActionManifest,
	RemoteActionProxy,
	RemoteCallOptions,
} from '../shared/actions.js';
import type { DefaultRpcMap, RpcActionMap } from './types.js';

export type PeerAwareSchema = AwarenessSchema & {
	peer: typeof PeerIdentity;
};

export const PeerAddressError = defineErrors({
	PeerNotFound: ({
		peerTarget,
		sawPeers,
		waitMs,
	}: {
		peerTarget: string;
		sawPeers: boolean;
		waitMs: number;
	}) => ({
		message: `no peer matches peer id "${peerTarget}"`,
		peerTarget,
		sawPeers,
		waitMs,
	}),
	PeerLeft: ({
		peerTarget,
		targetClientId,
		peerState,
	}: {
		peerTarget: string;
		targetClientId: number;
		peerState: PeerAwarenessState;
	}) => ({
		message: `peer "${peerTarget}" disconnected before RPC response arrived`,
		peerTarget,
		targetClientId,
		peerState,
	}),
});
export type PeerAddressError = InferErrors<typeof PeerAddressError>;

export type WireRpcError = RpcError;

export type RemoteCallError = WireRpcError | PeerAddressError;

export type RemotePeerCallOptions = RemoteCallOptions & {
	waitForPeerMs?: number;
};

export type RemoteClientOptions<
	TSchema extends PeerAwareSchema = PeerAwareSchema,
> = {
	awareness: AwarenessAttachment<TSchema>;
	rpc: SyncRpcAttachment;
};

export type RemoteClient = ReturnType<typeof createRemoteClient>;

export function createRemoteClient(options: RemoteClientOptions) {
	return {
		actions<T>(
			peerId: string,
		): RemoteActionProxy<T, RemoteCallError, RemotePeerCallOptions> {
			return createRemoteActionProxy<T>(options, peerId);
		},
		describe(
			peerId: string,
			callOptions?: RemotePeerCallOptions,
		): Promise<Result<ActionManifest, RemoteCallError>> {
			return invokeRemoteAction<{
				'system.describe': { input: undefined; output: ActionManifest };
			}>(options, peerId, 'system.describe', undefined, callOptions);
		},
		invoke<
			TMap extends RpcActionMap = DefaultRpcMap,
			TAction extends string & keyof TMap = string & keyof TMap,
		>(
			peerId: string,
			action: TAction,
			input?: TMap[TAction]['input'],
			callOptions?: RemotePeerCallOptions,
		): Promise<Result<TMap[TAction]['output'], RemoteCallError>> {
			return invokeRemoteAction(options, peerId, action, input, callOptions);
		},
	};
}

function createRemoteActionProxy<T>(
	options: RemoteClientOptions,
	peerId: string,
): RemoteActionProxy<T, RemoteCallError, RemotePeerCallOptions> {
	const send: Sender = (path, input, callOptions) =>
		invokeRemoteAction(options, peerId, path, input, callOptions);

	return buildProxy<
		RemoteActionProxy<T, RemoteCallError, RemotePeerCallOptions>
	>([], send);
}

async function invokeRemoteAction<
	TMap extends RpcActionMap = DefaultRpcMap,
	TAction extends string & keyof TMap = string & keyof TMap,
>(
	options: RemoteClientOptions,
	peerId: string,
	action: TAction,
	input?: TMap[TAction]['input'],
	callOptions: RemotePeerCallOptions = {},
): Promise<Result<TMap[TAction]['output'], RemoteCallError>> {
	const { waitForPeerMs = 0, timeout } = callOptions;
	const found = await waitForPeer(options.awareness, peerId, {
		timeoutMs: waitForPeerMs,
	});
	if (found.error !== null) return found;

	const { clientId: targetClientId, state: peerState } = found.data;

	return new Promise<Result<TMap[TAction]['output'], RemoteCallError>>(
		(resolveCall) => {
			let settled = false;
			let unsubscribe = () => {};
			const settle = (
				value: Result<TMap[TAction]['output'], RemoteCallError>,
			) => {
				if (settled) return;
				settled = true;
				unsubscribe();
				resolveCall(value);
			};

			unsubscribe = options.awareness.observe(() => {
				if (!hasPeerClient(options.awareness, targetClientId, peerId)) {
					settle(
						PeerAddressError.PeerLeft({
							peerTarget: peerId,
							targetClientId,
							peerState,
						}),
					);
				}
			});

			if (!hasPeerClient(options.awareness, targetClientId, peerId)) {
				settle(
					PeerAddressError.PeerLeft({
						peerTarget: peerId,
						targetClientId,
						peerState,
					}),
				);
				return;
			}

			options.rpc
				.rpc<TMap, TAction>(targetClientId, action, input, { timeout })
				.then((result) => settle(result))
				.catch((cause) =>
					settle(Err(RpcError.ActionFailed({ action, cause }).error)),
				);
		},
	);
}

function peerStates<TSchema extends PeerAwareSchema>(
	awareness: AwarenessAttachment<TSchema>,
): Map<number, PeerAwarenessState> {
	const result = new Map<number, PeerAwarenessState>();
	for (const [clientId, state] of awareness.peers()) {
		result.set(clientId, { peer: state.peer });
	}
	return result;
}

function hasPeerClient<TSchema extends PeerAwareSchema>(
	awareness: AwarenessAttachment<TSchema>,
	clientId: number,
	peerId: string,
): boolean {
	const state = peerStates(awareness).get(clientId);
	return state?.peer.id === peerId;
}

async function waitForPeer<TSchema extends PeerAwareSchema>(
	awareness: AwarenessAttachment<TSchema>,
	peerId: string,
	{ timeoutMs }: { timeoutMs: number },
): Promise<Result<ResolvedPeer, PeerAddressError>> {
	let sawPeers = false;
	const tryMatch = (): ResolvedPeer | undefined => {
		const peers = peerStates(awareness);
		if (peers.size > 0) sawPeers = true;
		const sortedClientIds = [...peers.keys()].sort((a, b) => a - b);
		for (const clientId of sortedClientIds) {
			const state = peers.get(clientId)!;
			if (state.peer.id === peerId) return { clientId, state };
		}
		return undefined;
	};

	const initial = tryMatch();
	if (initial) return Ok(initial);

	if (timeoutMs <= 0) {
		return PeerAddressError.PeerNotFound({
			peerTarget: peerId,
			sawPeers,
			waitMs: timeoutMs,
		});
	}

	return new Promise((resolve) => {
		const stop = awareness.observe(() => {
			const hit = tryMatch();
			if (hit) {
				clearTimeout(timer);
				stop();
				resolve(Ok(hit));
			}
		});
		const timer = setTimeout(() => {
			stop();
			resolve(
				PeerAddressError.PeerNotFound({
					peerTarget: peerId,
					sawPeers,
					waitMs: timeoutMs,
				}),
			);
		}, timeoutMs);
	});
}

type Sender = (
	path: string,
	input: unknown,
	options?: RemotePeerCallOptions,
) => Promise<Result<unknown, RemoteCallError>>;

function buildProxy<T>(path: string[], send: Sender): T {
	const target = (() => {}) as unknown as object;
	return new Proxy(target, {
		get(_t, prop) {
			if (typeof prop !== 'string') return undefined;
			if (prop === 'then') return undefined;
			return buildProxy([...path, prop], send);
		},
		apply(_t, _this, args: unknown[]) {
			const [input, options] = args as [unknown?, RemotePeerCallOptions?];
			return send(path.join('.'), input, options);
		},
	}) as T;
}
