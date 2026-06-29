/**
 * The channel port is the one seam between the sync socket's raw text frames and
 * the relay channel, so the test pins both directions: outbound frames serialize
 * to text, and the inbound text stream is narrowed to channel frames only
 * (presence, dispatch, and junk are ignored here, still handled elsewhere).
 */

import { expect, test } from 'bun:test';
import { createChannelPort, type TextFramePort } from './channel-port.js';
import type { ChannelFrame } from './protocol.js';

function fakeTextPort() {
	const sent: string[] = [];
	const listeners = new Set<(text: string) => void>();
	const port: TextFramePort = {
		send: (text) => sent.push(text),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return { port, sent, deliver: (text: string) => listeners.forEach((l) => l(text)) };
}

test('send serializes a channel frame to text', () => {
	const { port, sent } = fakeTextPort();
	const channelPort = createChannelPort(port);
	const open: ChannelFrame = { type: 'channel_open', id: 'c1', target: 'b', route: 'books' };
	channelPort.send(open);
	expect(sent).toEqual([JSON.stringify(open)]);
});

test('onFrame narrows inbound text to channel frames only', () => {
	const { port, deliver } = fakeTextPort();
	const channelPort = createChannelPort(port);
	const got: ChannelFrame[] = [];
	channelPort.onFrame((frame) => got.push(frame));

	deliver(JSON.stringify({ type: 'presence', peers: [] })); // not a channel frame
	deliver('not json at all'); // not parseable
	const accept: ChannelFrame = { type: 'channel_accept', id: 'c1' };
	deliver(JSON.stringify(accept)); // a channel frame

	expect(got).toEqual([accept]);
});

test('the returned unsubscribe detaches the listener', () => {
	const { port, deliver } = fakeTextPort();
	const channelPort = createChannelPort(port);
	const got: ChannelFrame[] = [];
	const off = channelPort.onFrame((frame) => got.push(frame));
	off();
	deliver(JSON.stringify({ type: 'channel_accept', id: 'c1' }));
	expect(got).toEqual([]);
});
