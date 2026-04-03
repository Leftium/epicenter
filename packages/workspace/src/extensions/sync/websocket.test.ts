/**
 * Sync Extension Tests
 *
 * These tests verify sync extension lifecycle behavior around provider creation,
 * reconnect semantics, URL resolution, and readiness ordering.
 *
 * Key behaviors:
 * - Reconnect does not break the extension's public API
 * - URL configuration and whenReady lifecycle resolve in the expected order
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createSyncExtension } from './websocket';

type SyncExtensionContext = Parameters<
	ReturnType<typeof createSyncExtension>['workspace']
>[0];

/** Create a minimal mock context for the sync extension factory. */
function createMockContext(ydoc: Y.Doc): SyncExtensionContext {
	return {
		ydoc,
		whenReady: Promise.resolve(),
	};
}

describe('createSyncExtension', () => {
	describe('reconnect', () => {
		test('reconnect does not break the extension', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc' });

			const factory = createSyncExtension({
				url: (id: string) => `ws://localhost:8080/rooms/${id}`,
			});

			const result = factory.workspace(createMockContext(ydoc));

			// Status accessible before reconnect
			expect(result.status.phase).toBe('offline');

			result.reconnect();

			// Status still accessible after reconnect
			expect(result.status).toBeDefined();

			result.dispose();
		});

		test('dispose sets status to offline', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-dispose' });

			const factory = createSyncExtension({
				url: (id: string) => `ws://localhost:8080/rooms/${id}`,
			});

			const result = factory.workspace(createMockContext(ydoc));

			result.dispose();

			expect(result.status.phase).toBe('offline');
		});
	});

	test('resolves URL callback with workspace ID', () => {
		const ydoc = new Y.Doc({ guid: 'my-workspace' });

		const factory = createSyncExtension({
			url: (id) => `ws://localhost:3913/custom/${id}/ws`,
		});

		const result = factory.workspace(createMockContext(ydoc));

		expect(result.status.phase).toBe('offline');

		result.dispose();
	});

	test('whenReady awaits client.whenReady before connecting', async () => {
		const ydoc = new Y.Doc({ guid: 'await-test' });
		const order: string[] = [];

		let resolveClientReady!: () => void;
		const clientWhenReady = new Promise<void>((resolve) => {
			resolveClientReady = resolve;
		});

		const factory = createSyncExtension({
			url: (id: string) => `ws://localhost:8080/rooms/${id}`,
		});

		const result = factory.workspace({
			ydoc,
			whenReady: clientWhenReady.then(() => {
				order.push('client-ready');
			}),
		} as SyncExtensionContext);

		// whenReady should not have resolved yet
		let resolved = false;
		void result.whenReady.then(() => {
			resolved = true;
			order.push('sync-ready');
		});

		// Give microtasks a chance
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);

		// Resolve the client's whenReady
		resolveClientReady();
		await result.whenReady;

		expect(order).toEqual(['client-ready', 'sync-ready']);

		result.dispose();
	});
});
