/**
 * The relay-channel router: the server half of the universal device-channel
 * relay's floor.
 *
 * It multiplexes named request/response channels (the four `channel_*` frames of
 * `@epicenter/workspace/relay-channel`) over the account-room WebSocket each
 * device already holds, forwarding a channel's bytes BLIND between a caller
 * socket and a target device's socket. It never parses the MCP (or HTTP) payload
 * inside a `channel_data` frame.
 *
 * This is a clean GENERALIZATION of the deleted dispatch path, not a revival:
 * the deleted relay parsed `action`/`input` and a typed `Result`, and that logic
 * lived inside the sync text-frame handler (`core.ts`) and `open-collaboration`.
 * This router imports nothing from Yjs sync, MCP, the action registry, or any
 * workspace reducer; it depends only on the wire {@link ChannelFrame} protocol
 * and the minimal {@link RoomSocket} surface. `RoomCore` reaches it through one
 * delegation in `handleTextFrame` and one call in `removeConnection`; the sync
 * layer never learns a channel exists. Sharing the connection is fine; coupling
 * the channel logic to the sync logic is the trap this separation avoids.
 *
 * The relay enforces routing integrity from the already-authenticated identity:
 * it routes only among sockets of the same owner (the per-user fleet that shares
 * the account room) and never lets a caller forge the peer it reaches. It is NOT
 * the security boundary on the tool call; that stays the device endpoint's own
 * check (the [collapse spec]'s "the endpoint is the boundary, never the relay").
 */

import {
	type ChannelFrame,
	type ChannelOpenFrame,
	type ChannelResetCode,
	checkChannelFrame,
} from '@epicenter/workspace/relay-channel';
import type { RoomSocket } from './contracts.js';

/** WebSocket-spec OPEN readyState. */
const WS_READY_OPEN = 1;

/**
 * Most live channels one caller socket may hold at once. A same-user device is
 * already authenticated, so this is not a trust boundary; it bounds the memory a
 * misbehaving or compromised own-device can pin inside the 30-minute socket
 * lifetime by opening channels it never closes.
 */
const MAX_CHANNELS_PER_SOCKET = 64;

/**
 * What the router needs from the room it lives in, injected so it stays free of
 * `RoomCore`'s Yjs and presence state.
 *
 * - `findDevice` resolves a target `nodeId` to its most-recently-connected open
 *   socket IN THIS ROOM (the room is one user's fleet), or `null` if offline.
 *   This is `RoomCore.pickRecipient`.
 * - `ownerOf` returns the server-resolved `userId` stamped on a socket at
 *   upgrade, so the router can refuse cross-owner routing.
 */
export type ChannelRouterDeps = {
	findDevice(nodeId: string): RoomSocket | null;
	ownerOf(socket: RoomSocket): string | undefined;
};

/** One live channel: the two sockets the relay forwards bytes between. */
type Channel = { caller: RoomSocket; target: RoomSocket };

export type ChannelRouter = {
	/**
	 * Route one validated {@link ChannelFrame} from `socket`. An `channel_open`
	 * establishes a channel to a same-owner device (or rejects); every other frame
	 * is forwarded to the channel's peer, dropped if `socket` is not a party to it.
	 */
	handleFrame(socket: RoomSocket, frame: ChannelFrame): void;
	/**
	 * Tear down every channel touching a now-closed socket, resetting its peer so
	 * a half-open channel never lingers. Called from `RoomCore.removeConnection`.
	 */
	onClose(socket: RoomSocket): void;
	/** Whether an untrusted text frame is a channel frame this router owns. */
	owns(frame: unknown): frame is ChannelFrame;
};

export function createChannelRouter(deps: ChannelRouterDeps): ChannelRouter {
	/** Live channels keyed by the caller-minted channel id. */
	const channels = new Map<string, Channel>();

	/** Send a frame to a socket, swallowing a dead-socket failure (its close runs `onClose`). */
	function send(socket: RoomSocket, frame: ChannelFrame): void {
		if (socket.readyState !== WS_READY_OPEN) return;
		try {
			socket.send(JSON.stringify(frame));
		} catch {
			/* dead socket; its close event runs onClose cleanup */
		}
	}

	/** End a channel toward one socket with a reason code. */
	function reset(
		socket: RoomSocket,
		id: string,
		code: ChannelResetCode,
		reason?: string,
	): void {
		send(socket, {
			type: 'channel_reset',
			id,
			code,
			...(reason !== undefined && { reason }),
		});
	}

	/** The other party to a channel, or `null` if `socket` is not one of them. */
	function peerOf(channel: Channel, socket: RoomSocket): RoomSocket | null {
		if (socket === channel.caller) return channel.target;
		if (socket === channel.target) return channel.caller;
		return null;
	}

	/** Count the live channels a socket currently owns as the caller. */
	function callerChannelCount(socket: RoomSocket): number {
		let count = 0;
		for (const channel of channels.values()) {
			if (channel.caller === socket) count += 1;
		}
		return count;
	}

	function handleOpen(caller: RoomSocket, frame: ChannelOpenFrame): void {
		if (channels.has(frame.id)) {
			reset(caller, frame.id, 'protocol_error', 'duplicate channel id');
			return;
		}
		if (callerChannelCount(caller) >= MAX_CHANNELS_PER_SOCKET) {
			reset(caller, frame.id, 'refused', 'channel limit reached');
			return;
		}
		const target = deps.findDevice(frame.target);
		if (!target || target.readyState !== WS_READY_OPEN) {
			reset(caller, frame.id, 'offline');
			return;
		}
		// Routing integrity: only within one owner's fleet, never across users. In a
		// personal account room every socket shares the owner, so this is a belt to
		// the room's structural suspenders; it is the real gate in a shared room.
		const callerOwner = deps.ownerOf(caller);
		if (!callerOwner || callerOwner !== deps.ownerOf(target)) {
			reset(caller, frame.id, 'refused', 'cross-owner routing refused');
			return;
		}
		channels.set(frame.id, { caller, target });
		// Stamp the server-authored source, OVERWRITING any caller-provided one, so
		// the acceptor authorizes by an identity the caller cannot forge. The target
		// reads `route` to pick its handler and answers with accept or reset.
		send(target, {
			...frame,
			source: { kind: 'user', userId: callerOwner },
		});
	}

	return {
		owns: (frame): frame is ChannelFrame => checkChannelFrame.Check(frame),

		handleFrame(socket, frame) {
			if (frame.type === 'channel_open') {
				handleOpen(socket, frame);
				return;
			}

			const channel = channels.get(frame.id);
			// A frame for an unknown channel is a late arrival (the channel was already
			// reset or its peer closed); drop it silently.
			if (!channel) return;
			const peer = peerOf(channel, socket);
			// Only a party to the channel may drive it; a third socket forging an id it
			// learned cannot inject into someone else's channel.
			if (!peer) return;

			// A reset ends the whole channel; accept/data/end are forwarded and the
			// channel stays live (end is a half-close, so the reverse direction may
			// still flow).
			if (frame.type === 'channel_reset') channels.delete(frame.id);
			send(peer, frame);
		},

		onClose(socket) {
			for (const [id, channel] of channels) {
				if (channel.caller === socket) {
					channels.delete(id);
					reset(channel.target, id, 'closed', 'caller disconnected');
				} else if (channel.target === socket) {
					channels.delete(id);
					reset(channel.caller, id, 'offline', 'target disconnected');
				}
			}
		},
	};
}
