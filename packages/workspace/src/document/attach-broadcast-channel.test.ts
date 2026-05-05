import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachBroadcastChannel } from './attach-broadcast-channel.js';

const originalBroadcastChannel = globalThis.BroadcastChannel;

class FakeBroadcastChannel {
	static names: string[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(public name: string) {
		FakeBroadcastChannel.names.push(name);
	}

	postMessage(): void {}

	close(): void {}
}

describe('attachBroadcastChannel', () => {
	beforeEach(() => {
		FakeBroadcastChannel.names = [];
		Object.assign(globalThis, {
			BroadcastChannel:
				FakeBroadcastChannel as unknown as typeof BroadcastChannel,
		});
	});

	afterEach(() => {
		Object.assign(globalThis, { BroadcastChannel: originalBroadcastChannel });
	});

	test('defaults to ydoc.guid as the local channel key', () => {
		const ydoc = new Y.Doc({ guid: 'epicenter.fuji' });

		attachBroadcastChannel(ydoc);

		expect(FakeBroadcastChannel.names).toEqual(['yjs:epicenter.fuji']);
		ydoc.destroy();
	});

	test('uses channelKey without changing ydoc.guid', () => {
		const ydoc = new Y.Doc({ guid: 'epicenter.fuji' });

		attachBroadcastChannel(ydoc, {
			channelKey: 'epicenter:v1:user:user-123:yjs:epicenter.fuji',
		});

		expect(FakeBroadcastChannel.names).toEqual([
			'yjs:epicenter:v1:user:user-123:yjs:epicenter.fuji',
		]);
		expect(ydoc.guid).toBe('epicenter.fuji');
		ydoc.destroy();
	});
});
