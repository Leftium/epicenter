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
 *   - actionPaths alphabetically sorted; no runtime verbs leak into the
 *     published action surface (runtime verbs ride RUNTIME_REQUEST, not
 *     ACTION_REQUEST)
 *   - peers.list() never includes self
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	type Actions,
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

function setup<TActions extends Actions = Actions>(
	actions: TActions = {} as TActions,
) {
	const ydoc = new Y.Doc({ guid: 'open-collab-test' });
	const collaboration = openCollaboration<TActions>(ydoc, {
		url: 'wss://ignored.invalid/',
		openWebSocket: stalledOpenWebSocket,
		identity,
		actions,
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

	test('collaboration.actions returns exactly the user-supplied tree', () => {
		const list = defineQuery({ handler: () => [] });
		const { ydoc, collaboration } = setup({ tabs: { list } });
		try {
			expect(collaboration.actions).toEqual({ tabs: { list } });
			expect(Object.keys(collaboration.actions)).toEqual(['tabs']);
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

	test('walkActions emits exactly the user-authored paths (runtime verbs never appear here)', () => {
		const actions = {
			tabs: { list: defineQuery({ handler: () => [] }) },
		};
		const paths = Array.from(walkActions(actions), ([path]) => path).sort();
		expect(paths).toEqual(['tabs.list']);
	});

	test('a top-level `system` key in user actions is legal and shows up in actionPaths', () => {
		// The runtime previously reserved `system.*`; the runtime/action plane
		// split means user code can use the name freely now.
		const actions = {
			system: { ping: defineQuery({ handler: () => 'pong' }) },
		};
		const paths = Array.from(walkActions(actions), ([path]) => path).sort();
		expect(paths).toEqual(['system.ping']);
	});
});
