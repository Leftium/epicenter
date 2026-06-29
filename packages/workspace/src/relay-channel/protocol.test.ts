/**
 * The relay-channel protocol is a wire contract both the browser transport and
 * the server router validate untrusted input against, so the test pins what the
 * one shared validator accepts and rejects: every well-formed frame, and the
 * malformed shapes a peer (or a buggy relay) could send.
 */

import { describe, expect, test } from 'bun:test';
import {
	type ChannelFrame,
	checkChannelFrame,
} from './protocol.js';

describe('checkChannelFrame', () => {
	const valid: ChannelFrame[] = [
		{ type: 'channel_open', id: 'c1', target: 'peerB', route: 'books' },
		{ type: 'channel_accept', id: 'c1' },
		{ type: 'channel_data', id: 'c1', bytes: 'aGVsbG8=' },
		{ type: 'channel_end', id: 'c1' },
		{ type: 'channel_reset', id: 'c1', code: 'offline' },
		{ type: 'channel_reset', id: 'c1', code: 'refused', reason: 'no route' },
	];

	test.each(valid)('accepts %o', (frame) => {
		expect(checkChannelFrame.Check(frame)).toBe(true);
	});

	const invalid: unknown[] = [
		// not a channel frame at all (presence / sync text)
		{ type: 'presence', peers: [] },
		{ type: 'dispatch_request', id: 'c1', to: 'x', action: 'y' },
		// missing required fields
		{ type: 'channel_open', id: 'c1', route: 'books' }, // no target
		{ type: 'channel_data', id: 'c1' }, // no bytes
		// wrong field types
		{ type: 'channel_data', id: 'c1', bytes: 123 },
		{ type: 'channel_open', id: 1, target: 'b', route: 'books' },
		// reset code outside the closed vocabulary
		{ type: 'channel_reset', id: 'c1', code: 'kaboom' },
		// junk
		'channel_data',
		null,
	];

	test.each(invalid)('rejects %o', (frame) => {
		expect(checkChannelFrame.Check(frame)).toBe(false);
	});
});
