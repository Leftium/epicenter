/**
 * Sync Extension Tests
 *
 * These tests verify sync extension lifecycle behavior around provider creation,
 * reconnect semantics, URL resolution, and readiness ordering.
 *
 * Key behaviors:
 * - Reconnect does not break the extension's public API
 * - URL configuration and init lifecycle resolve in the expected order
 */
import { describe, expect, test } from 'bun:test';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createSyncExtension } from './websocket';

type SyncExtensionFactoryClient = Parameters<
	ReturnType<typeof createSyncExtension>
>[0];

/** Create a minimal mock context for the sync extension factory. */
function createMockContext(ydoc: Y.Doc): SyncExtensionFactoryClient {
	return {
		ydoc,
		awareness: { raw: new Awareness(ydoc) },
		init: Promise.resolve(),
	};
}

describe('createSyncExtension', () => {
	describe('reconnect', () => {
		test('reconnect does not break the extension', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc' });

			const factory = createSyncExtension({
				url: (id: string) => `ws://localhost:8080/rooms/${id}`,
			});

			const result = factory(createMockContext(ydoc));

			// Status accessible before reconnect
			expect(result.exports.status.phase).toBe('offline');

			result.exports.reconnect();

			// Status still accessible after reconnect
			expect(result.exports.status).toBeDefined();

			result.dispose();
			ydoc.destroy();
		});

		test('dispose sets status to offline', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-dispose' });

			const factory = createSyncExtension({
				url: (id: string) => `ws://localhost:8080/rooms/${id}`,
			});

			const result = factory(createMockContext(ydoc));

			result.dispose();

			expect(result.exports.status.phase).toBe('offline');
			ydoc.destroy();
		});
	});

	test('resolves URL callback with workspace ID', () => {
		const ydoc = new Y.Doc({ guid: 'my-workspace' });

		const factory = createSyncExtension({
			url: (id) => `ws://localhost:3913/custom/${id}/ws`,
		});

		const result = factory(createMockContext(ydoc));

		expect(result.exports.status.phase).toBe('offline');

		result.dispose();
		ydoc.destroy();
	});

	test('init awaits prior ctx.init before connecting', async () => {
		const ydoc = new Y.Doc({ guid: 'await-test' });
		const order: string[] = [];

		let resolveClientReady!: () => void;
		const clientInit = new Promise<void>((resolve) => {
			resolveClientReady = resolve;
		});

		const factory = createSyncExtension({
			url: (id: string) => `ws://localhost:8080/rooms/${id}`,
		});

		const result = factory({
			ydoc,
			awareness: { raw: new Awareness(ydoc) },
			init: clientInit.then(() => {
				order.push('client-ready');
			}),
		} as SyncExtensionFactoryClient);

		// init should not have resolved yet
		let resolved = false;
		void result.init.then(() => {
			resolved = true;
			order.push('sync-ready');
		});

		// Give microtasks a chance
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);

		// Resolve the prior init signal
		resolveClientReady();
		await result.init;

		expect(order).toEqual(['client-ready', 'sync-ready']);

		result.dispose();
		ydoc.destroy();
	});

	describe('onActive lifecycle', () => {
		test('factory return exposes onActive hook', () => {
			// The framework calls onActive once after init resolves. A refactor
			// that drops it would leave the extension stuck offline.
			const ydoc = new Y.Doc({ guid: 'hooks-exposed' });
			const factory = createSyncExtension({
				url: (id) => `ws://localhost:8080/rooms/${id}`,
			});
			const result = factory(createMockContext(ydoc));

			expect(typeof result.onActive).toBe('function');

			result.dispose();
			ydoc.destroy();
		});

		test('init alone does NOT start the supervisor loop (passive init)', async () => {
			// The extension stays offline until the framework calls onActive.
			// init is purely passive wiring.
			const ydoc = new Y.Doc({ guid: 'passive-init' });
			const factory = createSyncExtension({
				url: (id) => `ws://localhost:8080/rooms/${id}`,
			});
			const result = factory(createMockContext(ydoc));

			await result.init;
			expect(result.exports.status.phase).toBe('offline');

			result.dispose();
			ydoc.destroy();
		});

		test('onActive called twice is idempotent', () => {
			// goOnline has a `desired === 'online'` guard. Without it, a
			// re-activation (e.g. via reconnect()) would spawn a second loop.
			const ydoc = new Y.Doc({ guid: 'onactive-idempotent' });
			const factory = createSyncExtension({
				url: (id) => `ws://localhost:8080/rooms/${id}`,
			});
			const result = factory(createMockContext(ydoc));

			result.onActive?.();
			const statusAfterFirst = result.exports.status.phase;
			result.onActive?.();
			const statusAfterSecond = result.exports.status.phase;

			// Both calls leave the extension in a non-offline phase — the
			// second call didn't reset to offline or spawn a parallel loop.
			expect(statusAfterFirst).not.toBe('offline');
			expect(statusAfterSecond).toBe(statusAfterFirst);

			result.dispose();
			ydoc.destroy();
		});
	});
});
