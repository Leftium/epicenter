/**
 * Sync Extension Tests
 *
 * These tests verify sync extension lifecycle behavior around provider creation,
 * reconnect semantics, URL resolution, and readiness ordering. They ensure extension
 * consumers get a stable provider reference and deterministic teardown behavior.
 *
 * Key behaviors:
 * - Reconnect swaps providers and destroys previous connections
 * - URL configuration and whenReady lifecycle resolve in the expected order
 */
import { describe, expect, test } from 'bun:test';
import type { SyncProvider } from '@epicenter/sync';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createSyncExtension } from './sync';

/** The shape of the sync extension exports. */
type SyncExtensionExports = {
	provider: SyncProvider;
	reconnect: (newConfig?: {
		url?: string;
		token?: string;
		getToken?: () => Promise<string>;
	}) => void;
};

/** The shape returned by the extension factory. */
type SyncExtensionResult = {
	exports: SyncExtensionExports;
	lifecycle: { whenReady: Promise<unknown>; destroy: () => void };
};

type SyncExtensionFactoryClient = Parameters<
	ReturnType<typeof createSyncExtension>
>[0];

/** Create a minimal mock client for the sync extension factory. */
function createMockClient(ydoc: Y.Doc) {
	return {
		ydoc,
		awareness: { raw: new Awareness(ydoc) },
		whenReady: Promise.resolve(),
	} as unknown as SyncExtensionFactoryClient; // Minimal mock — only properties the sync extension accesses are provided
}

describe('createSyncExtension', () => {
	describe('reconnect', () => {
		test('destroys old provider and creates new provider', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc' });

			const factory = createSyncExtension({
				url: 'ws://localhost:8080/workspaces/{id}/sync',
			});

			const result = factory(
				createMockClient(ydoc),
			) as unknown as SyncExtensionResult;

			const oldProvider = result.exports.provider;
			expect(oldProvider).toBeDefined();

			// Reconnect with a different URL
			result.exports.reconnect({
				url: 'ws://cloud.example.com/workspaces/test-doc/sync',
			});

			// Old provider should be destroyed (offline)
			expect(oldProvider.status).toBe('offline');

			// New provider should be a different instance
			const newProvider = result.exports.provider;
			expect(newProvider).not.toBe(oldProvider);
			expect(newProvider).toBeDefined();

			// Cleanup
			result.lifecycle.destroy();
		});

		test('provider getter returns current provider after reconnect', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-getter' });

			const factory = createSyncExtension({
				url: 'ws://localhost:8080/workspaces/{id}/sync',
			});

			const result = factory(
				createMockClient(ydoc),
			) as unknown as SyncExtensionResult;

			const firstProvider = result.exports.provider;
			result.exports.reconnect({
				url: 'ws://server-2/workspaces/test-doc-getter/sync',
			});
			const secondProvider = result.exports.provider;
			result.exports.reconnect({
				url: 'ws://server-3/workspaces/test-doc-getter/sync',
			});
			const thirdProvider = result.exports.provider;

			// Each reconnect should yield a different provider
			expect(firstProvider).not.toBe(secondProvider);
			expect(secondProvider).not.toBe(thirdProvider);

			// Previous providers should be offline
			expect(firstProvider.status).toBe('offline');
			expect(secondProvider.status).toBe('offline');

			result.lifecycle.destroy();
		});

		test('destroy uses current provider after reconnect', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-destroy' });

			const factory = createSyncExtension({
				url: 'ws://localhost:8080/workspaces/{id}/sync',
			});

			const result = factory(
				createMockClient(ydoc),
			) as unknown as SyncExtensionResult;
			result.exports.reconnect({
				url: 'ws://cloud.example.com/workspaces/test-doc-destroy/sync',
			});

			const currentProvider = result.exports.provider;
			result.lifecycle.destroy();

			// The current (post-reconnect) provider should be destroyed
			expect(currentProvider.status).toBe('offline');
		});
	});

	test('resolves URL with {id} placeholder', () => {
		const ydoc = new Y.Doc({ guid: 'my-workspace' });

		const factory = createSyncExtension({
			url: 'ws://localhost:3913/workspaces/{id}/sync',
		});

		// The factory creates a provider with connect: false, so no actual connection
		const result = factory(
			createMockClient(ydoc),
		) as unknown as SyncExtensionResult;

		// Provider should exist and be offline (not connected)
		expect(result.exports.provider).toBeDefined();
		expect(result.exports.provider.status).toBe('offline');

		result.lifecycle.destroy();
	});

	test('resolves URL when url config is a function', () => {
		const ydoc = new Y.Doc({ guid: 'my-workspace' });

		const factory = createSyncExtension({
			url: (id) => `ws://localhost:3913/custom/${id}/ws`,
		});

		const result = factory(
			createMockClient(ydoc),
		) as unknown as SyncExtensionResult;

		expect(result.exports.provider).toBeDefined();
		expect(result.exports.provider.status).toBe('offline');

		result.lifecycle.destroy();
	});

	test('whenReady awaits client.whenReady before connecting', async () => {
		const ydoc = new Y.Doc({ guid: 'await-test' });
		const order: string[] = [];

		let resolveClientReady!: () => void;
		const clientWhenReady = new Promise<void>((resolve) => {
			resolveClientReady = resolve;
		});

		const factory = createSyncExtension({
			url: 'ws://localhost:8080/workspaces/{id}/sync',
		});

		const result = factory({
			ydoc,
			awareness: { raw: new Awareness(ydoc) },
			whenReady: clientWhenReady.then(() => {
				order.push('client-ready');
			}),
		} as SyncExtensionFactoryClient) as unknown as SyncExtensionResult;

		// whenReady should not have resolved yet
		let resolved = false;
		void result.lifecycle.whenReady.then(() => {
			resolved = true;
			order.push('sync-ready');
		});

		// Give microtasks a chance
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);

		// Resolve the client's whenReady
		resolveClientReady();
		await result.lifecycle.whenReady;

		expect(order).toEqual(['client-ready', 'sync-ready']);

		result.lifecycle.destroy();
	});
});
