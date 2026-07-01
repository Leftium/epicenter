/**
 * Build a {@link ChannelPort} over a raw text-frame port.
 *
 * The account-room sync connection (`document/open-collaboration`) exposes a
 * {@link TextFramePort}: send a text frame, and observe every inbound text frame.
 * That port is sync-agnostic; it knows nothing of channels. This adapter is the
 * one place the relay-channel layer meets it: it serializes outbound channel
 * frames to JSON text, and narrows the inbound text stream to the channel frames
 * (the rest, presence and anything else, is ignored here and still
 * handled by their own consumers). So the channel layer rides the sync socket
 * while staying a separate module from sync, exactly the seam the floor requires.
 *
 * Browser-safe: JSON plus the TypeBox validator, no node builtin.
 */

import { checkChannelFrame } from './protocol.js';
import type { ChannelPort } from './transport.js';

/**
 * The minimal seam a sync connection exposes for the relay channel: send one
 * text frame, and subscribe to every inbound text frame. `open-collaboration`'s
 * exposed port satisfies this structurally.
 */
export type TextFramePort = {
	/** Send one text frame over the account-room socket. */
	send(text: string): void;
	/** Observe every inbound text frame; returns an unsubscribe. */
	subscribe(listener: (text: string) => void): () => void;
};

/** Adapt a {@link TextFramePort} into the {@link ChannelPort} the transport and acceptor consume. */
export function createChannelPort(textPort: TextFramePort): ChannelPort {
	return {
		send: (frame) => textPort.send(JSON.stringify(frame)),
		onFrame: (listener) =>
			textPort.subscribe((text) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(text);
				} catch {
					return; // not JSON; not ours
				}
				if (checkChannelFrame.Check(parsed)) listener(parsed);
			}),
	};
}
