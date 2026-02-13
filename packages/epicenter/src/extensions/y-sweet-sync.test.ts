import { describe, expect, test } from 'bun:test';
import type { ClientToken } from '@epicenter/y-sweet';
import { STATUS_OFFLINE, type YSweetProvider } from '@epicenter/y-sweet';
import * as Y from 'yjs';
import { ySweetSync } from './y-sweet-sync';

/**
 * Mock auth that returns a WebSocket URL for the given server.
 * No real connection is attempted since providers are created with `connect: false`
 * (via persistence) or never actually open a WebSocket in tests.
 */
function mockAuth(server: string) {
	return (docId: string): Promise<ClientToken> =>
		Promise.resolve({ url: `ws://${server}/d/${docId}/ws` });
}

/** The shape of the ySweetSync extension exports (beyond Lifecycle). */
type YSweetSyncExports = {
	provider: YSweetProvider;
	whenSynced: Promise<unknown>;
	reconnect: (newAuth: (docId: string) => Promise<ClientToken>) => void;
	destroy: () => void;
};

describe('ySweetSync', () => {
	describe('reconnect', () => {
		test('destroys old provider, creates new provider, leaves persistence untouched', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc' });

			let persistenceInitCount = 0;
			let persistenceDestroyCount = 0;

			const factory = ySweetSync({
				auth: mockAuth('localhost:8080'),
				persistence: ({ ydoc: _ydoc }) => {
					persistenceInitCount++;
					return {
						whenSynced: Promise.resolve(),
						destroy: () => {
							persistenceDestroyCount++;
						},
					};
				},
			});

			const extension = factory({
				ydoc,
			} as any) as unknown as YSweetSyncExports;

			const oldProvider = extension.provider;
			expect(oldProvider).toBeDefined();
			expect(persistenceInitCount).toBe(1);

			// Reconnect with a different auth callback
			extension.reconnect(mockAuth('cloud.example.com'));

			// Old provider should be destroyed (offline)
			expect(oldProvider.status).toBe(STATUS_OFFLINE);

			// New provider should be a different instance
			const newProvider = extension.provider;
			expect(newProvider).not.toBe(oldProvider);
			expect(newProvider).toBeDefined();

			// Persistence should NOT have been reinitialized
			expect(persistenceInitCount).toBe(1);
			expect(persistenceDestroyCount).toBe(0);

			// Cleanup
			extension.destroy();
		});

		test('provider getter returns current provider after reconnect', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-getter' });

			const factory = ySweetSync({
				auth: mockAuth('localhost:8080'),
				persistence: () => ({
					whenSynced: Promise.resolve(),
					destroy: () => {},
				}),
			});

			const extension = factory({
				ydoc,
			} as any) as unknown as YSweetSyncExports;

			const firstProvider = extension.provider;
			extension.reconnect(mockAuth('server-2'));
			const secondProvider = extension.provider;
			extension.reconnect(mockAuth('server-3'));
			const thirdProvider = extension.provider;

			// Each reconnect should yield a different provider
			expect(firstProvider).not.toBe(secondProvider);
			expect(secondProvider).not.toBe(thirdProvider);

			// Previous providers should be offline
			expect(firstProvider.status).toBe(STATUS_OFFLINE);
			expect(secondProvider.status).toBe(STATUS_OFFLINE);

			extension.destroy();
		});

		test('destroy uses current provider after reconnect', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-destroy' });

			const factory = ySweetSync({
				auth: mockAuth('localhost:8080'),
				persistence: () => ({
					whenSynced: Promise.resolve(),
					destroy: () => {},
				}),
			});

			const extension = factory({
				ydoc,
			} as any) as unknown as YSweetSyncExports;
			extension.reconnect(mockAuth('cloud.example.com'));

			const currentProvider = extension.provider;
			extension.destroy();

			// The current (post-reconnect) provider should be destroyed
			expect(currentProvider.status).toBe(STATUS_OFFLINE);
		});
	});
});
