/**
 * Tests for `createChildDocs`: the bound child-doc runtime.
 *
 * Verifies the three layers compose correctly: the injected `attach*` layout is
 * applied to each doc (shape), the cache dedups by guid and refcounts opens
 * (lifecycle), and the connection fields are pre-bound (so `open(guid)` needs
 * only the guid). Local storage uses `fake-indexeddb`; the fake `openWebSocket`
 * parks the sync supervisor in CONNECTING and unparks on `ydoc.destroy()`, so
 * the runtime is exercised without a real relay.
 */

import { describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import type { Guid } from '../shared/id.js';
import { attachPlainText } from './attach-plain-text.js';
import type { ConnectionConfig } from './connect-doc.js';
import { createChildDocs } from './create-child-docs.js';
import { asDeviceId } from './device-id.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

/**
 * Minimal fake WebSocket: stays in CONNECTING (readyState 0) until `close()`,
 * then transitions to CLOSED and fires `onclose`. `ydoc.destroy()` triggers
 * the close, which unparks the supervisor so the test process exits cleanly.
 */
function fakeWebSocket(): Promise<WebSocket> {
	const ws = {
		readyState: 0,
		onclose: null as ((e: CloseEvent) => void) | null,
		close() {
			if (ws.readyState === 3) return;
			ws.readyState = 3;
			ws.onclose?.({ code: 1000, reason: '' } as CloseEvent);
		},
	};
	return Promise.resolve(ws as unknown as WebSocket);
}

const connection: ConnectionConfig = {
	server: 'api.test.invalid',
	baseURL: 'https://api.test.invalid',
	ownerId: asOwnerId('owner-1'),
	openWebSocket: fakeWebSocket,
	onReconnectSignal: () => () => {},
	deviceId: asDeviceId('device-1'),
};

const GUID = 'epicenter-test.entries.row-1.content' as Guid;

describe('createChildDocs', () => {
	test('applies the injected layout and exposes lifecycle fields', async () => {
		const bodies = createChildDocs(connection)(attachPlainText, { gcTime: 0 });
		const handle = bodies.open(GUID);
		try {
			// Layout surface is present (attachPlainText -> { binding, read, write }).
			handle.write('hello');
			expect(handle.read()).toBe('hello');
			// Lifecycle fields the runtime adds.
			expect(handle.guid).toBe(GUID);
			// `whenLoaded` resolves once local IDB state has replayed (opaque value).
			await handle.whenLoaded;
		} finally {
			handle[Symbol.dispose]();
		}
	});

	test('dedups by guid: same guid shares one underlying Y.Doc', () => {
		const bodies = createChildDocs(connection)(attachPlainText, { gcTime: 0 });
		const a = bodies.open(GUID);
		const b = bodies.open(GUID);
		try {
			// Distinct handles...
			expect(a).not.toBe(b);
			// ...over one shared doc: a write through `a` is visible through `b`.
			a.write('shared');
			expect(b.read()).toBe('shared');
		} finally {
			a[Symbol.dispose]();
			b[Symbol.dispose]();
		}
	});

	test('refcounts: N opens require N disposes before teardown', () => {
		const bodies = createChildDocs(connection)(attachPlainText, { gcTime: 0 });
		const a = bodies.open(GUID);
		a.write('persisted');
		const b = bodies.open(GUID);

		// First dispose drops refcount to 1; the doc stays alive.
		a[Symbol.dispose]();
		expect(b.read()).toBe('persisted');

		// Last dispose tears the entry down; the next open rebuilds fresh (empty).
		b[Symbol.dispose]();
		const c = bodies.open(GUID);
		try {
			expect(c.read()).toBe('');
		} finally {
			c[Symbol.dispose]();
		}
	});

	test('different guids are independent docs', () => {
		const bodies = createChildDocs(connection)(attachPlainText, { gcTime: 0 });
		const one = bodies.open(GUID);
		const two = bodies.open('epicenter-test.entries.row-2.content' as Guid);
		try {
			one.write('first');
			expect(two.read()).toBe('');
			expect(one.guid).not.toBe(two.guid);
		} finally {
			one[Symbol.dispose]();
			two[Symbol.dispose]();
		}
	});
});
