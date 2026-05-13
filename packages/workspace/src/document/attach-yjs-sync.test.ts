/**
 * Smoke tests for `attachYjsSync`.
 *
 * No real WebSocket: `openWebSocket` returns a never-resolving promise so the
 * supervisor parks in `connecting`. The assertions verify the public shape
 * `attachYjsSync` returns (status/lifecycle handles only — no presence, no
 * RPC) and that `ydoc.destroy()` resolves `whenDisposed`.
 *
 * Covers spec Phase 2.2:
 *   - supervisor lifecycle threads through
 *   - status starts in a non-connected phase
 *   - whenDisposed resolves on ydoc.destroy()
 *   - no goOffline / no awareness on the public type
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachYjsSync, type YjsSyncAttachment } from './attach-yjs-sync.js';

/**
 * Returns a fake WebSocket that parks in CONNECTING until `close()` is
 * called, at which point it transitions to CLOSED and fires `onclose`. The
 * promise resolves synchronously so the supervisor can register its abort
 * listener and react when the ydoc is destroyed.
 */
function stalledOpenWebSocket(): Promise<WebSocket> {
	const listeners: Record<string, EventListener[]> = {};
	const ws = {
		readyState: 0, // CONNECTING
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

describe('attachYjsSync', () => {
	test('returns the documented lifecycle surface', () => {
		const ydoc = new Y.Doc({ guid: 'yjs-sync-shape' });
		const sync = attachYjsSync(ydoc, {
			url: 'wss://ignored.invalid/',
			openWebSocket: stalledOpenWebSocket,
		});

		try {
			expect(typeof sync.status).toBe('object');
			expect(['offline', 'connecting']).toContain(sync.status.phase);
			expect(sync.whenConnected).toBeInstanceOf(Promise);
			expect(sync.whenDisposed).toBeInstanceOf(Promise);
			expect(typeof sync.onStatusChange).toBe('function');
			expect(typeof sync.reconnect).toBe('function');
		} finally {
			ydoc.destroy();
		}
	});

	test('whenDisposed resolves after ydoc.destroy()', async () => {
		const ydoc = new Y.Doc({ guid: 'yjs-sync-dispose' });
		const sync = attachYjsSync(ydoc, {
			url: 'wss://ignored.invalid/',
			openWebSocket: stalledOpenWebSocket,
		});

		ydoc.destroy();
		await sync.whenDisposed;
		// If we reach here the promise resolved. No further assertion needed.
		expect(true).toBe(true);
	});

	test('reconnect() is callable on an unconnected sync without throwing', () => {
		const ydoc = new Y.Doc({ guid: 'yjs-sync-reconnect' });
		const sync = attachYjsSync(ydoc, {
			url: 'wss://ignored.invalid/',
			openWebSocket: stalledOpenWebSocket,
		});

		try {
			expect(() => sync.reconnect()).not.toThrow();
		} finally {
			ydoc.destroy();
		}
	});

	test('onStatusChange returns an unsubscribe function', () => {
		const ydoc = new Y.Doc({ guid: 'yjs-sync-status' });
		const sync = attachYjsSync(ydoc, {
			url: 'wss://ignored.invalid/',
			openWebSocket: stalledOpenWebSocket,
		});

		try {
			const unsubscribe = sync.onStatusChange(() => {});
			expect(typeof unsubscribe).toBe('function');
			unsubscribe();
		} finally {
			ydoc.destroy();
		}
	});
});

describe('YjsSyncAttachment type shape', () => {
	test('public type does not expose goOffline or awareness', () => {
		// Compile-time assertion: dropped fields must not be reachable through
		// the exported `YjsSyncAttachment` type. If either is re-added, this
		// `@ts-expect-error` flips and breaks the build.
		type _NoGoOffline = YjsSyncAttachment extends { goOffline: unknown }
			? never
			: true;
		type _NoAwareness = YjsSyncAttachment extends { awareness: unknown }
			? never
			: true;
		const noGoOffline: _NoGoOffline = true;
		const noAwareness: _NoAwareness = true;
		expect(noGoOffline).toBe(true);
		expect(noAwareness).toBe(true);
	});
});
