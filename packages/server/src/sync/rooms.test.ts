/**
 * Room Manager Unit Tests
 *
 * Tests for room lifecycle, connection management, broadcasting, and eviction.
 * Co-located with rooms.ts for easy discovery.
 */

import { describe, expect, test } from 'bun:test';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createRoomManager } from './rooms';

// ============================================================================
// Test Utilities
// ============================================================================

/** Create a mock WebSocket raw reference (just an empty object) */
function createMockWsRaw(): object {
	return {};
}

/** Create a mock send function that captures data */
function createMockSend(): {
	send: (data: Buffer) => void;
	calls: Buffer[];
} {
	const calls: Buffer[] = [];
	return {
		send: (data: Buffer) => calls.push(data),
		calls,
	};
}

// ============================================================================
// join() Tests
// ============================================================================

describe('join()', () => {
	test('creates a room with Y.Doc when first client joins (standalone mode)', () => {
		const manager = createRoomManager();
		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		const result = manager.join('room1', wsRaw, send);

		expect(result).not.toBeNull();
		expect(result?.doc).toBeInstanceOf(Y.Doc);
		expect(result?.awareness).toBeInstanceOf(Awareness);
	});

	test('returns doc and awareness for new room', () => {
		const manager = createRoomManager();
		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		const result = manager.join('room1', wsRaw, send);

		expect(result).not.toBeNull();
		expect(result?.doc).toBeDefined();
		expect(result?.awareness).toBeDefined();
	});

	test('second client joining same room gets the same doc', () => {
		const manager = createRoomManager();
		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const { send: send1 } = createMockSend();
		const { send: send2 } = createMockSend();

		const result1 = manager.join('room1', wsRaw1, send1);
		const result2 = manager.join('room1', wsRaw2, send2);

		expect(result1?.doc).toBe(result2?.doc);
		expect(result1?.awareness).toBe(result2?.awareness);
	});

	test('returns undefined when getDoc returns undefined (integrated mode, unknown room)', () => {
		const manager = createRoomManager({
			getDoc: () => undefined,
		});
		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		const result = manager.join('unknown-room', wsRaw, send);

		expect(result).toBeUndefined();
	});

	test('uses doc from getDoc when provided (integrated mode)', () => {
		const externalDoc = new Y.Doc();
		const manager = createRoomManager({
			getDoc: (roomId) => (roomId === 'room1' ? externalDoc : undefined),
		});
		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		const result = manager.join('room1', wsRaw, send);

		expect(result?.doc).toBe(externalDoc);
	});

	test('calls onRoomCreated when creating a room in standalone mode', () => {
		let createdRoomId: string | undefined;
		let createdDoc: Y.Doc | undefined;

		const manager = createRoomManager({
			onRoomCreated: (roomId, doc) => {
				createdRoomId = roomId;
				createdDoc = doc;
			},
		});
		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		manager.join('room1', wsRaw, send);

		expect(createdRoomId).toBe('room1');
		expect(createdDoc).toBeInstanceOf(Y.Doc);
	});

	test('does NOT call onRoomCreated in integrated mode (getDoc provided)', () => {
		let callCount = 0;
		const externalDoc = new Y.Doc();

		const manager = createRoomManager({
			getDoc: () => externalDoc,
			onRoomCreated: () => {
				callCount++;
			},
		});
		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		manager.join('room1', wsRaw, send);

		expect(callCount).toBe(0);
	});

	test('cancels eviction timer when client joins before timer fires', async () => {
		let evictedRoomId: string | undefined;

		const manager = createRoomManager({
			evictionTimeout: 100,
			onRoomEvicted: (roomId) => {
				evictedRoomId = roomId;
			},
		});

		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const { send: send1 } = createMockSend();
		const { send: send2 } = createMockSend();

		// First client joins
		manager.join('room1', wsRaw1, send1);

		// First client leaves (starts eviction timer)
		manager.leave('room1', wsRaw1);

		// Wait a bit, then second client joins before timer fires
		await new Promise((r) => setTimeout(r, 50));
		manager.join('room1', wsRaw2, send2);

		// Wait for original timer to have fired
		await new Promise((r) => setTimeout(r, 100));

		// Room should NOT be evicted because new client joined
		expect(evictedRoomId).toBeUndefined();
		expect(manager.getDoc('room1')).toBeDefined();
	});
});

// ============================================================================
// leave() Tests
// ============================================================================

describe('leave()', () => {
	test('removes connection from room', () => {
		const manager = createRoomManager();
		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const { send: send1 } = createMockSend();
		const { send: send2, calls: calls2 } = createMockSend();

		manager.join('room1', wsRaw1, send1);
		manager.join('room1', wsRaw2, send2);

		// Broadcast to room1 (should reach both)
		const mockData = Buffer.from([1, 2, 3]);
		manager.broadcast('room1', mockData);

		// Leave with wsRaw1
		manager.leave('room1', wsRaw1);

		// Broadcast again (should only reach wsRaw2)
		manager.broadcast('room1', mockData, wsRaw1);

		// wsRaw2 should have received the broadcast
		expect(calls2.length).toBeGreaterThan(0);

		// Room should still exist with wsRaw2
		expect(manager.getDoc('room1')).toBeDefined();
	});

	test('starts eviction timer when room becomes empty', async () => {
		let evictedRoomId: string | undefined;

		const manager = createRoomManager({
			evictionTimeout: 50,
			onRoomEvicted: (roomId) => {
				evictedRoomId = roomId;
			},
		});

		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		manager.join('room1', wsRaw, send);
		manager.leave('room1', wsRaw);

		// Room should still exist immediately after leave
		expect(manager.getDoc('room1')).toBeDefined();

		// Wait for eviction timer to fire
		await new Promise((r) => setTimeout(r, 100));

		// Room should be evicted
		expect(evictedRoomId).toBe('room1');
		expect(manager.getDoc('room1')).toBeUndefined();
	});

	test('calls onRoomEvicted after timer fires', async () => {
		let evictedRoomId: string | undefined;
		let evictedDoc: Y.Doc | undefined;

		const manager = createRoomManager({
			evictionTimeout: 50,
			onRoomEvicted: (roomId, doc) => {
				evictedRoomId = roomId;
				evictedDoc = doc;
			},
		});

		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		const result = manager.join('room1', wsRaw, send);
		manager.leave('room1', wsRaw);

		// Wait for eviction
		await new Promise((r) => setTimeout(r, 100));

		expect(evictedRoomId).toBe('room1');
		expect(evictedDoc).toBe(result?.doc);
	});
});

// ============================================================================
// broadcast() Tests
// ============================================================================

describe('broadcast()', () => {
	test('sends data to all connections except sender', () => {
		const manager = createRoomManager();
		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const wsRaw3 = createMockWsRaw();

		const { send: send1, calls: calls1 } = createMockSend();
		const { send: send2, calls: calls2 } = createMockSend();
		const { send: send3, calls: calls3 } = createMockSend();

		manager.join('room1', wsRaw1, send1);
		manager.join('room1', wsRaw2, send2);
		manager.join('room1', wsRaw3, send3);

		const mockData = Buffer.from([1, 2, 3]);
		manager.broadcast('room1', mockData, wsRaw1);

		// wsRaw1 (sender) should NOT receive
		expect(calls1.length).toBe(0);

		// wsRaw2 and wsRaw3 should receive
		expect(calls2.length).toBe(1);
		expect(calls3.length).toBe(1);
		expect(calls2[0]).toEqual(mockData);
		expect(calls3[0]).toEqual(mockData);
	});

	test('does nothing for non-existent room', () => {
		const manager = createRoomManager();

		// Should not throw
		expect(() => {
			manager.broadcast('non-existent', Buffer.from([1, 2, 3]));
		}).not.toThrow();
	});

	test('broadcasts to all when no sender specified', () => {
		const manager = createRoomManager();
		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();

		const { send: send1, calls: calls1 } = createMockSend();
		const { send: send2, calls: calls2 } = createMockSend();

		manager.join('room1', wsRaw1, send1);
		manager.join('room1', wsRaw2, send2);

		const mockData = Buffer.from([1, 2, 3]);
		manager.broadcast('room1', mockData);

		// Both should receive
		expect(calls1.length).toBe(1);
		expect(calls2.length).toBe(1);
	});
});

// ============================================================================
// Eviction Tests
// ============================================================================

describe('eviction', () => {
	test('room is destroyed after eviction timeout', async () => {
		const manager = createRoomManager({
			evictionTimeout: 50,
		});

		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		manager.join('room1', wsRaw, send);
		expect(manager.getDoc('room1')).toBeDefined();

		manager.leave('room1', wsRaw);

		// Room still exists immediately
		expect(manager.getDoc('room1')).toBeDefined();

		// Wait for eviction
		await new Promise((r) => setTimeout(r, 100));

		// Room is destroyed
		expect(manager.getDoc('room1')).toBeUndefined();
	});

	test('eviction is cancelled if new client joins before timeout', async () => {
		const manager = createRoomManager({
			evictionTimeout: 100,
		});

		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const { send: send1 } = createMockSend();
		const { send: send2 } = createMockSend();

		const doc1 = manager.join('room1', wsRaw1, send1)?.doc;

		manager.leave('room1', wsRaw1);

		// Wait a bit, then rejoin
		await new Promise((r) => setTimeout(r, 50));
		const doc2 = manager.join('room1', wsRaw2, send2)?.doc;

		// Should be the same doc (room was not destroyed)
		expect(doc1).toBe(doc2);

		// Wait past original eviction timeout
		await new Promise((r) => setTimeout(r, 100));

		// Room should still exist
		expect(manager.getDoc('room1')).toBeDefined();
	});

	test('getDoc returns undefined after eviction', async () => {
		const manager = createRoomManager({
			evictionTimeout: 50,
		});

		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		manager.join('room1', wsRaw, send);
		manager.leave('room1', wsRaw);

		// Wait for eviction
		await new Promise((r) => setTimeout(r, 100));

		expect(manager.getDoc('room1')).toBeUndefined();
	});
});

// ============================================================================
// Utility Methods Tests
// ============================================================================

describe('utility methods', () => {
	test('rooms() lists active room IDs', () => {
		const manager = createRoomManager();
		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const wsRaw3 = createMockWsRaw();

		const { send: send1 } = createMockSend();
		const { send: send2 } = createMockSend();
		const { send: send3 } = createMockSend();

		manager.join('room1', wsRaw1, send1);
		manager.join('room2', wsRaw2, send2);
		manager.join('room3', wsRaw3, send3);

		const roomIds = manager.rooms();

		expect(roomIds).toContain('room1');
		expect(roomIds).toContain('room2');
		expect(roomIds).toContain('room3');
		expect(roomIds.length).toBe(3);
	});

	test('getDoc() returns doc for existing room', () => {
		const manager = createRoomManager();
		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		const result = manager.join('room1', wsRaw, send);
		const doc = manager.getDoc('room1');

		expect(doc).toBe(result?.doc);
	});

	test('getDoc() returns undefined for non-existent room', () => {
		const manager = createRoomManager();

		expect(manager.getDoc('non-existent')).toBeUndefined();
	});

	test('getAwareness() returns awareness for existing room', () => {
		const manager = createRoomManager();
		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		const result = manager.join('room1', wsRaw, send);
		const awareness = manager.getAwareness('room1');

		expect(awareness).toBe(result?.awareness);
	});

	test('getAwareness() returns undefined for non-existent room', () => {
		const manager = createRoomManager();

		expect(manager.getAwareness('non-existent')).toBeUndefined();
	});

	test('destroy() clears all rooms', async () => {
		const manager = createRoomManager({
			evictionTimeout: 10_000, // Long timeout to ensure destroy() is what clears
		});

		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const { send: send1 } = createMockSend();
		const { send: send2 } = createMockSend();

		manager.join('room1', wsRaw1, send1);
		manager.join('room2', wsRaw2, send2);

		expect(manager.rooms().length).toBe(2);

		manager.destroy();

		expect(manager.rooms().length).toBe(0);
		expect(manager.getDoc('room1')).toBeUndefined();
		expect(manager.getDoc('room2')).toBeUndefined();
	});

	test('destroy() clears eviction timers', async () => {
		let evictedCount = 0;

		const manager = createRoomManager({
			evictionTimeout: 50,
			onRoomEvicted: () => {
				evictedCount++;
			},
		});

		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		manager.join('room1', wsRaw, send);
		manager.leave('room1', wsRaw);

		// Destroy before eviction timer fires
		await new Promise((r) => setTimeout(r, 25));
		manager.destroy();

		// Wait past original eviction timeout
		await new Promise((r) => setTimeout(r, 100));

		// onRoomEvicted should NOT have been called (timer was cleared)
		expect(evictedCount).toBe(0);
	});
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('integration', () => {
	test('multiple rooms operate independently', () => {
		const manager = createRoomManager();

		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const { send: send1, calls: calls1 } = createMockSend();
		const { send: send2, calls: calls2 } = createMockSend();

		const doc1 = manager.join('room1', wsRaw1, send1)?.doc;
		const doc2 = manager.join('room2', wsRaw2, send2)?.doc;

		// Docs should be different
		expect(doc1).not.toBe(doc2);

		// Broadcast to room1 should not affect room2
		manager.broadcast('room1', Buffer.from([1, 2, 3]), wsRaw1);
		expect(calls1.length).toBe(0); // wsRaw1 is sender, excluded
		expect(calls2.length).toBe(0); // wsRaw2 is in different room
	});

	test('connection can rejoin after leaving', () => {
		const manager = createRoomManager();

		const wsRaw = createMockWsRaw();
		const { send } = createMockSend();

		const doc1 = manager.join('room1', wsRaw, send)?.doc;
		manager.leave('room1', wsRaw);
		const doc2 = manager.join('room1', wsRaw, send)?.doc;

		// Should be the same doc (room was not evicted yet)
		expect(doc1).toBe(doc2);
	});

	test('awareness is shared across connections in same room', () => {
		const manager = createRoomManager();

		const wsRaw1 = createMockWsRaw();
		const wsRaw2 = createMockWsRaw();
		const { send: send1 } = createMockSend();
		const { send: send2 } = createMockSend();

		const awareness1 = manager.join('room1', wsRaw1, send1)?.awareness;
		const awareness2 = manager.join('room1', wsRaw2, send2)?.awareness;

		// Should be the same awareness instance
		expect(awareness1).toBe(awareness2);
	});
});
