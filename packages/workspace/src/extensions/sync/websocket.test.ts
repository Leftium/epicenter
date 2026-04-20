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

	describe('bind/release lifecycle (onActive/onIdle)', () => {
		test('factory return exposes onActive and onIdle hooks', () => {
			// The framework relies on these being present. A refactor that
			// drops them would silently revert to always-on sync, which is
			// exactly what the bind/release work was designed to prevent.
			const ydoc = new Y.Doc({ guid: 'hooks-exposed' });
			const factory = createSyncExtension({
				url: (id) => `ws://localhost:8080/rooms/${id}`,
			});
			const result = factory(createMockContext(ydoc));

			expect(typeof result.onActive).toBe('function');
			expect(typeof result.onIdle).toBe('function');

			result.dispose();
			ydoc.destroy();
		});

		test('init alone does NOT start the supervisor loop (passive init)', async () => {
			// The whole point of splitting init is that the sync extension
			// stays offline until the framework calls onActive. Without this
			// property, per-doc extensions would always connect on .get(),
			// defeating bind/release.
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

		test('onActive called twice without intervening onIdle is idempotent', () => {
			// goOnline has a `desired === 'online'` guard. Without it, a
			// re-activation during grace (which the framework cancels, but
			// bugs happen) would spawn a second supervisor loop.
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

		test('onIdle called twice without intervening onActive is a no-op', () => {
			// Symmetric to above — a double idle shouldn't re-enter any
			// teardown path that might throw or leak.
			const ydoc = new Y.Doc({ guid: 'onidle-idempotent' });
			const factory = createSyncExtension({
				url: (id) => `ws://localhost:8080/rooms/${id}`,
			});
			const result = factory(createMockContext(ydoc));

			result.onActive?.();
			result.onIdle?.();
			expect(result.exports.status.phase).toBe('offline');

			// Should not throw.
			result.onIdle?.();
			expect(result.exports.status.phase).toBe('offline');

			result.dispose();
			ydoc.destroy();
		});

		test('repeated onActive/onIdle cycles do not leak Y.Doc update listeners', () => {
			// Yjs's y-websocket uses disconnect/connect (not destroy/recreate)
			// so doc update listeners are attached ONCE at factory time and
			// survive cycling. Lock this in: if a refactor accidentally moved
			// listener attach/detach into onActive/onIdle, we'd see growth.
			const ydoc = new Y.Doc({ guid: 'no-listener-leak' });
			const factory = createSyncExtension({
				url: (id) => `ws://localhost:8080/rooms/${id}`,
			});
			const result = factory(createMockContext(ydoc));

			// Capture baseline listener counts — Y.Doc uses an Observable
			// pattern with an internal observer map. We can at minimum assert
			// that the count is bounded by inspecting its `_observers` map
			// (documented internal, used in Yjs's own tests too).
			// biome-ignore lint/suspicious/noExplicitAny: accessing internal observer map
			const observers = (ydoc as any)._observers as Map<string, Set<unknown>>;
			const baseline = observers.get('updateV2')?.size ?? 0;

			for (let i = 0; i < 5; i++) {
				result.onActive?.();
				result.onIdle?.();
			}

			const afterCycles = observers.get('updateV2')?.size ?? 0;
			expect(afterCycles).toBe(baseline);

			result.dispose();
			ydoc.destroy();
		});
	});
});
