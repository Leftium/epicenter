import { describe, expect, test } from 'bun:test';
import type { SyncProvider } from '@epicenter/sync';
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

describe('createSyncExtension', () => {
	describe('reconnect', () => {
		test('destroys old provider, creates new provider, leaves persistence untouched', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc' });

			let persistenceInitCount = 0;
			let persistenceDestroyCount = 0;

			const factory = createSyncExtension({
				url: 'ws://localhost:8080/workspaces/{id}/sync',
				persistence: () => {
					persistenceInitCount++;
					return {
						whenReady: Promise.resolve(),
						destroy: () => {
							persistenceDestroyCount++;
						},
					};
				},
			});

			const result = factory({
				ydoc,
			} as any) as unknown as SyncExtensionResult;

			const oldProvider = result.exports.provider;
			expect(oldProvider).toBeDefined();
			expect(persistenceInitCount).toBe(1);

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

			// Persistence should NOT have been reinitialized
			expect(persistenceInitCount).toBe(1);
			expect(persistenceDestroyCount).toBe(0);

			// Cleanup
			result.lifecycle.destroy();
		});

		test('provider getter returns current provider after reconnect', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-getter' });

			const factory = createSyncExtension({
				url: 'ws://localhost:8080/workspaces/{id}/sync',
				persistence: () => ({
					whenReady: Promise.resolve(),
					destroy: () => {},
				}),
			});

			const result = factory({
				ydoc,
			} as any) as unknown as SyncExtensionResult;

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
				persistence: () => ({
					whenReady: Promise.resolve(),
					destroy: () => {},
				}),
			});

			const result = factory({
				ydoc,
			} as any) as unknown as SyncExtensionResult;
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
			persistence: () => ({
				whenReady: Promise.resolve(),
				destroy: () => {},
			}),
		});

		// The factory creates a provider with connect: false, so no actual connection
		const result = factory({
			ydoc,
		} as any) as unknown as SyncExtensionResult;

		// Provider should exist and be offline (not connected)
		expect(result.exports.provider).toBeDefined();
		expect(result.exports.provider.status).toBe('offline');

		result.lifecycle.destroy();
	});

	test('resolves URL with function', () => {
		const ydoc = new Y.Doc({ guid: 'my-workspace' });

		const factory = createSyncExtension({
			url: (id) => `ws://localhost:3913/custom/${id}/ws`,
			persistence: () => ({
				whenReady: Promise.resolve(),
				destroy: () => {},
			}),
		});

		const result = factory({
			ydoc,
		} as any) as unknown as SyncExtensionResult;

		expect(result.exports.provider).toBeDefined();
		expect(result.exports.provider.status).toBe('offline');

		result.lifecycle.destroy();
	});
});
