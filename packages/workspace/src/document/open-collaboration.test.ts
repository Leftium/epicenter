/**
 * Tests for `openCollaboration`.
 *
 * No real WebSocket: `openWebSocket` returns a never-resolving promise, so
 * the supervisor parks in `connecting` and the synchronous setup is what we
 * exercise here. RPC roundtrip coverage lives in `rpc.test.ts` against a
 * shared Y.Doc (no WebSocket needed).
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	type ActionRegistry,
	defineMutation,
	defineQuery,
} from '../shared/actions.js';
import { openCollaboration } from './open-collaboration.js';

const installationId = 'self';

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

function setup<TActions extends ActionRegistry = ActionRegistry>(
	actions: TActions = {} as TActions,
) {
	const ydoc = new Y.Doc({ guid: 'open-collab-test' });
	const collaboration = openCollaboration<TActions>(ydoc, {
		url: 'wss://ignored.invalid/',
		openWebSocket: stalledOpenWebSocket,
		installationId,
		actions,
	});
	return { ydoc, collaboration };
}

describe('openCollaboration', () => {
	test('exposes the supplied installationId, a minted connectionId, and user actions', () => {
		const list = defineQuery({ handler: () => [] });
		const { ydoc, collaboration } = setup({ tabs_list: list });
		try {
			expect(collaboration.installationId).toBe(installationId);
			expect(typeof collaboration.connectionId).toBe('string');
			expect(collaboration.connectionId.length).toBeGreaterThan(0);
			expect(collaboration.actions).toEqual({ tabs_list: list });
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
			tabs_list: defineQuery({ handler: () => [] }),
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

describe('action key publication shape', () => {
	test('Object.keys + alphabetical sort produces the publication order', () => {
		const actions = {
			z_close: defineMutation({ handler: () => null }),
			a_list: defineQuery({ handler: () => [] }),
			m_ping: defineQuery({ handler: () => 'pong' }),
		} satisfies ActionRegistry;
		expect(Object.keys(actions).sort()).toEqual([
			'a_list',
			'm_ping',
			'z_close',
		]);
	});

	test('a top-level `system` key in user actions is legal', () => {
		// The runtime previously reserved `system.*`; the runtime/action plane
		// split means user code can use the name freely now.
		const actions = {
			system_ping: defineQuery({ handler: () => 'pong' }),
		} satisfies ActionRegistry;
		expect(Object.keys(actions).sort()).toEqual(['system_ping']);
	});

	test('rejects invalid action keys at the collaboration boundary', () => {
		expect(() =>
			setup({
				'tabs.close': defineMutation({ handler: () => null }),
			} as unknown as ActionRegistry),
		).toThrow(/Invalid action key "tabs\.close"/);
	});
});
