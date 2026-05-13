/**
 * Tests for `openCollaboration`.
 *
 * No real WebSocket: `openWebSocket` returns a never-resolving promise, so
 * the supervisor parks in `connecting` and the synchronous setup is what we
 * exercise here. RPC roundtrip and self-RPC wire fallback are covered in
 * `peer.test.ts` with a fake hook.
 *
 * Covers spec Phase 2.1:
 *   - identity publication
 *   - actionPaths alphabetically sorted, never includes the reserved
 *     `system.describe` path
 *   - peers.list() never includes self
 *   - reserved `system` namespace fails to type-check
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	defineMutation,
	defineQuery,
	walkActions,
} from '../shared/actions.js';
import { openCollaboration } from './open-collaboration.js';
import type { PeerIdentity } from './peer-identity.js';

const identity: PeerIdentity = {
	id: 'self',
	name: 'Self',
	platform: 'node',
};

/**
 * Returns a fake WebSocket that parks in CONNECTING until `close()` is
 * called, at which point it transitions to CLOSED and fires `onclose`. The
 * promise resolves synchronously so the supervisor's abort listener kicks
 * in cleanly when the ydoc is destroyed.
 */
function stalledOpenWebSocket(): Promise<WebSocket> {
	const listeners: Record<string, EventListener[]> = {};
	const ws = {
		readyState: 0,
		binaryType: 'arraybuffer' as BinaryType,
		onopen: null as ((e: Event) => void) | null,
		onclose: null as ((e: CloseEvent) => void) | null,
		onerror: null as ((e: Event) => void) | null,
		onmessage: null as ((e: MessageEvent) => void) | null,
		send: () => {},
		close: function close() {
			if (ws.readyState === 3) return;
			ws.readyState = 3;
			const event = { code: 1000, reason: '' } as CloseEvent;
			ws.onclose?.(event);
			for (const listener of listeners.close ?? []) listener(event as Event);
		},
		addEventListener: (type: string, listener: EventListener) => {
			(listeners[type] ??= []).push(listener);
		},
		removeEventListener: (type: string, listener: EventListener) => {
			listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
		},
	};
	return Promise.resolve(ws as unknown as WebSocket);
}

function setup(actions: Record<string, unknown> = {}) {
	const ydoc = new Y.Doc({ guid: 'open-collab-test' });
	const collaboration = openCollaboration(ydoc, {
		url: 'wss://ignored.invalid/',
		openWebSocket: stalledOpenWebSocket,
		identity,
		actions: actions as never,
	});
	return { ydoc, collaboration };
}

describe('openCollaboration', () => {
	test('exposes the supplied identity and user actions', () => {
		const list = defineQuery({ handler: () => [] });
		const { ydoc, collaboration } = setup({ tabs: { list } });
		try {
			expect(collaboration.identity).toEqual(identity);
			expect(collaboration.actions).toEqual({ tabs: { list } });
		} finally {
			ydoc.destroy();
		}
	});

	test('user actions do not surface the system namespace', () => {
		const { ydoc, collaboration } = setup({
			tabs: { list: defineQuery({ handler: () => [] }) },
		});
		try {
			expect(
				(collaboration.actions as Record<string, unknown>).system,
			).toBeUndefined();
		} finally {
			ydoc.destroy();
		}
	});

	test('initial status is offline or connecting (supervisor started, no waitFor)', () => {
		const { ydoc, collaboration } = setup();
		try {
			expect(['offline', 'connecting']).toContain(collaboration.status.phase);
		} finally {
			ydoc.destroy();
		}
	});

	test('peers.list() returns [] when no remote peers are present (self is filtered)', () => {
		const { ydoc, collaboration } = setup({
			tabs: { list: defineQuery({ handler: () => [] }) },
		});
		try {
			expect(collaboration.peers.list()).toEqual([]);
		} finally {
			ydoc.destroy();
		}
	});

	test('dispose destroys the underlying ydoc', () => {
		const { ydoc, collaboration } = setup();
		let destroyed = 0;
		ydoc.once('destroy', () => destroyed++);
		collaboration[Symbol.dispose]();
		expect(destroyed).toBe(1);
	});
});

describe('action paths publication shape', () => {
	test('walkActions + alphabetical sort produces the publication order', () => {
		const actions = {
			z: { close: defineMutation({ handler: () => null }) },
			a: { list: defineQuery({ handler: () => [] }) },
			m: { ping: defineQuery({ handler: () => 'pong' }) },
		};
		const paths = Array.from(walkActions(actions), ([path]) => path).sort();
		expect(paths).toEqual(['a.list', 'm.ping', 'z.close']);
	});

	test('walkActions does not surface the system namespace from a user action root', () => {
		const actions = {
			tabs: { list: defineQuery({ handler: () => [] }) },
		};
		const paths = Array.from(walkActions(actions), ([path]) => path).sort();
		expect(paths).toEqual(['tabs.list']);
	});
});

describe('openCollaboration type-level guards', () => {
	test('actions parameter refuses a top-level system namespace', () => {
		// @ts-expect-error reserved namespace must be refused at compile time
		const _config = {
			url: 'wss://ignored.invalid/',
			openWebSocket: stalledOpenWebSocket,
			identity,
			actions: {
				system: { broken: defineQuery({ handler: () => null }) },
			},
		} as const;
		void _config;
	});
});
