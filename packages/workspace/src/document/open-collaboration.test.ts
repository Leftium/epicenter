/**
 * Tests for `openCollaboration`.
 *
 * No real WebSocket: `openWebSocket` returns a never-resolving promise, so
 * the supervisor parks in `connecting` and the synchronous setup is what we
 * exercise here.
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
 * called, at which point it transitions to CLOSED and fires `onclose`.
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
			listeners[type] ??= [];
			listeners[type].push(listener);
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
	test('exposes the supplied installationId and user actions', () => {
		const list = defineQuery({ handler: () => [] });
		const { ydoc, collaboration } = setup({ tabs_list: list });
		try {
			expect(collaboration.installationId).toBe(installationId);
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

	test('devices.list() returns [] when no remote peers have published liveness', () => {
		const { ydoc, collaboration } = setup({
			tabs_list: defineQuery({ handler: () => [] }),
		});
		try {
			expect(collaboration.devices.list()).toEqual([]);
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

describe('action key validation', () => {
	test('rejects invalid action keys at the collaboration boundary', () => {
		expect(() =>
			setup({
				'tabs.close': defineMutation({ handler: () => null }),
			} as unknown as ActionRegistry),
		).toThrow(/Invalid action key "tabs\.close"/);
	});
});
