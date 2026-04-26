import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import * as Y from 'yjs';
import { defineMutation } from '../shared/actions.js';
import { attachPeers } from './attach-peers.js';

function makeDoc() {
	const ydoc = new Y.Doc();
	const actions = {
		tabs: {
			close: defineMutation({
				input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
				handler: () => ({ closedCount: 0 }),
			}),
		},
	};
	return { ydoc, actions };
}

describe('attachPeers', () => {
	test('publishes device + derived offers synchronously at attach time', () => {
		const doc = makeDoc();
		const peers = attachPeers(doc, {
			device: { id: 'mac-1', name: 'MacBook', platform: 'web' },
		});

		const local = peers.awareness.getLocal();
		expect(local).toEqual({
			device: {
				id: 'mac-1',
				name: 'MacBook',
				platform: 'web',
				offers: { 'tabs.close': { type: 'mutation', input: expect.any(Object) } },
			},
		});
	});

	test('peers() excludes self, includes remote peers with valid state', () => {
		const doc = makeDoc();
		const peers = attachPeers(doc, {
			device: { id: 'mac-1', name: 'MacBook', platform: 'web' },
		});

		peers.awareness.raw.getStates().set(202, {
			device: {
				id: 'iphone-15',
				name: 'Phone',
				platform: 'tauri',
				offers: {},
			},
		});

		const result = peers.peers();
		expect(result.has(peers.awareness.raw.clientID)).toBe(false);
		expect(result.get(202)?.device.id).toBe('iphone-15');
	});

	test('findPeer matches by deviceId; returns undefined when absent', () => {
		const doc = makeDoc();
		const peers = attachPeers(doc, {
			device: { id: 'mac-1', name: 'MacBook', platform: 'web' },
		});

		peers.awareness.raw.getStates().set(202, {
			device: {
				id: 'iphone-15',
				name: 'Phone',
				platform: 'tauri',
				offers: {},
			},
		});

		const found = peers.findPeer('iphone-15');
		expect(found?.clientId).toBe(202);
		expect(found?.state.device.name).toBe('Phone');

		expect(peers.findPeer('ghost')).toBeUndefined();
	});

	test('findPeer prefers lowest clientId on duplicate deviceIds', () => {
		const doc = makeDoc();
		const peers = attachPeers(doc, {
			device: { id: 'mac-1', name: 'MacBook', platform: 'web' },
		});

		const dup = (id: number) =>
			peers.awareness.raw.getStates().set(id, {
				device: { id: 'shared', name: 'Shared', platform: 'web', offers: {} },
			});
		dup(200);
		dup(50);
		dup(100);

		expect(peers.findPeer('shared')?.clientId).toBe(50);
	});

	test('findPeer skips peers whose device fails validation', () => {
		const doc = makeDoc();
		const peers = attachPeers(doc, {
			device: { id: 'mac-1', name: 'MacBook', platform: 'web' },
		});

		peers.awareness.raw.getStates().set(202, { device: { id: 'malformed' } });
		expect(peers.findPeer('malformed')).toBeUndefined();
	});
});
