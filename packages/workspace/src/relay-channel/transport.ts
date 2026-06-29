/**
 * The relay-channel {@link PeerTransport}: the universal FLOOR.
 *
 * It opens a named request/response channel to a target device by multiplexing
 * the five `channel_*` frames over a {@link ChannelPort} (the account-room
 * WebSocket each device already holds), and hands back a {@link ByteChannel} the
 * MCP client rides like any byte channel. The agent loop and
 * `createMcpGatewayCatalog` never learn which transport is underneath; this is
 * the second impl behind the seam, the one a browser can use with no app.
 *
 * Browser-safe: it depends only on the wire protocol, the Web Streams bridge,
 * and a `ChannelPort` the caller wires to its sync connection. It imports no
 * node builtin and no transport-native dependency.
 */

import type {
	ByteChannel,
	OpenChannelOptions,
	PeerTransport,
} from '../peer-transport.js';
import { type ChannelBridge, createChannelBridge } from './channel-bytes.js';
import type { ChannelFrame } from './protocol.js';

/**
 * The seam to the account-room socket: send a channel frame, and subscribe to
 * the channel frames the relay forwards back. The owner of the sync connection
 * builds this from the supervisor's `send` and `onTextFrame` (filtered to
 * channel frames); the transport never touches the socket or the Yjs sync layer
 * directly.
 */
export type ChannelPort = {
	/** Emit one channel frame over the account-room socket. */
	send(frame: ChannelFrame): void;
	/** Subscribe to inbound channel frames; returns an unsubscribe. */
	onFrame(listener: (frame: ChannelFrame) => void): () => void;
};

export type RelayChannelTransportOptions = {
	/** Mint a channel id. Defaults to `crypto.randomUUID`. */
	generateId?: () => string;
};

/** A {@link PeerTransport} plus the unsubscribe that detaches it from its port. */
export type RelayChannelTransport = PeerTransport & {
	/** Detach from the port and reset every live channel. */
	close(): void;
};

/** An in-flight `openChannel` awaiting its `channel_accept`. */
type Opening = {
	kind: 'opening';
	resolve(channel: ByteChannel): void;
	reject(error: Error): void;
};
/** An established channel, bridged to a {@link ByteChannel}. */
type Live = { kind: 'live'; bridge: ChannelBridge };

export function createRelayChannelTransport(
	port: ChannelPort,
	options: RelayChannelTransportOptions = {},
): RelayChannelTransport {
	const generateId = options.generateId ?? (() => crypto.randomUUID());
	const channels = new Map<string, Opening | Live>();

	const unsubscribe = port.onFrame((frame) => {
		const entry = channels.get(frame.id);
		if (!entry) return; // not our channel (or already settled)

		if (entry.kind === 'opening') {
			if (frame.type === 'channel_accept') {
				const bridge = createChannelBridge({
					id: frame.id,
					send: (f) => port.send(f),
					onTeardown: () => channels.delete(frame.id),
				});
				channels.set(frame.id, { kind: 'live', bridge });
				entry.resolve(bridge.channel);
				return;
			}
			if (frame.type === 'channel_reset') {
				channels.delete(frame.id);
				entry.reject(refusedError(frame.code, frame.reason));
			}
			// A data/end frame before accept is a protocol oddity; ignore it.
			return;
		}

		if (frame.type === 'channel_data' || frame.type === 'channel_reset') {
			entry.bridge.handleInbound(frame);
		}
	});

	function openChannel(opts: OpenChannelOptions): Promise<ByteChannel> {
		const { target, route, signal } = opts;
		return new Promise<ByteChannel>((resolve, reject) => {
			if (signal?.aborted) {
				reject(abortError(signal));
				return;
			}
			const id = generateId();

			// Abort tears the channel down whether it is still opening (reject) or has
			// gone live (the MCP transport's own close also resets, so this is the
			// pre-accept guard); a reset tells the relay to drop the entry.
			const onAbort = () => {
				if (!channels.delete(id)) return;
				port.send({ type: 'channel_reset', id, code: 'cancelled' });
				reject(abortError(signal));
			};

			channels.set(id, {
				kind: 'opening',
				resolve: (channel) => {
					signal?.removeEventListener('abort', onAbort);
					resolve(channel);
				},
				reject: (error) => {
					signal?.removeEventListener('abort', onAbort);
					reject(error);
				},
			});
			signal?.addEventListener('abort', onAbort, { once: true });
			port.send({ type: 'channel_open', id, target, route });
		});
	}

	return {
		openChannel,
		close() {
			unsubscribe();
			for (const [id, entry] of channels) {
				// Reset every channel so the relay frees its entry instead of holding it
				// until the socket itself closes.
				port.send({ type: 'channel_reset', id, code: 'closed' });
				if (entry.kind === 'opening') {
					entry.reject(new Error('relay-channel transport closed'));
				} else {
					entry.bridge.handleInbound({ type: 'channel_reset', id, code: 'closed' });
				}
			}
			channels.clear();
		},
	};
}

/** The error a refused (or offline) open rejects with. */
function refusedError(code: string, reason?: string): Error {
	return new Error(
		`relay channel refused: ${code}${reason ? ` (${reason})` : ''}`,
	);
}

/** The error an aborted open rejects with. */
function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new Error('relay channel open aborted', { cause: signal?.reason });
}
