/**
 * Sync Engine Boundary Tests
 *
 * Verifies the same-process engine that apps/api composes after OAuth and
 * host policy have already resolved a subject-scoped room name.
 *
 * Key behaviors:
 * - HTTP sync forwards the raw request body to the selected room and returns
 *   metering data to the host route.
 * - WebSocket upgrades are forwarded by resolved room name.
 * - The engine module stays free of Better Auth and billing imports.
 */

import { expect, test } from 'bun:test';
import { createSyncEngine, type SyncRoom } from './sync-engine.js';

class FakeRoom implements SyncRoom {
	webSocketRequests: Request[] = [];
	syncBodies: Uint8Array[] = [];

	constructor(
		private readonly options: {
			diff?: Uint8Array | null;
			storageBytes?: number;
			snapshot?: Uint8Array;
		} = {},
	) {}

	async handleWebSocket(request: Request): Promise<Response> {
		this.webSocketRequests.push(request);
		return new Response('upgraded', { status: 101 });
	}

	async sync(body: Uint8Array): Promise<{
		diff: Uint8Array | null;
		storageBytes: number;
	}> {
		this.syncBodies.push(body);
		return {
			diff: this.options.diff ?? null,
			storageBytes: this.options.storageBytes ?? 42,
		};
	}

	async getDoc(): Promise<{ data: Uint8Array; storageBytes: number }> {
		return {
			data: this.options.snapshot ?? new Uint8Array([1, 2, 3]),
			storageBytes: this.options.storageBytes ?? 42,
		};
	}

	async dispatch(): Promise<{ data: unknown }> {
		return { data: 'ok' };
	}
}

function setup(roomsByName: Record<string, SyncRoom>) {
	const requestedRoomNames: string[] = [];
	const engine = createSyncEngine(
		{
			rooms: {
				get(roomName) {
					requestedRoomNames.push(roomName);
					const room = roomsByName[roomName];
					if (!room) throw new Error(`Missing test room: ${roomName}`);
					return room;
				},
			},
		},
		{ maxPayloadBytes: 4 },
	);
	return { engine, requestedRoomNames };
}

test('handleHttpSync forwards the request body to the resolved room name', async () => {
	const room = new FakeRoom({
		diff: new Uint8Array([9, 8]),
		storageBytes: 128,
	});
	const { engine, requestedRoomNames } = setup({
		'subject:user-1:rooms:notes': room,
	});

	const result = await engine.handleHttpSync(
		new Request('https://api.test/rooms/notes', {
			method: 'POST',
			body: new Uint8Array([1, 2, 3]),
		}),
		{ roomName: 'subject:user-1:rooms:notes' },
	);

	expect(requestedRoomNames).toEqual(['subject:user-1:rooms:notes']);
	expect(room.syncBodies).toHaveLength(1);
	const syncBody = room.syncBodies[0];
	if (!syncBody) throw new Error('Expected sync body');
	expect(Array.from(syncBody)).toEqual([1, 2, 3]);
	expect(result.storageBytes).toBe(128);
	expect(result.response.status).toBe(200);
	expect(result.response.headers.get('content-type')).toBe(
		'application/octet-stream',
	);
	expect(
		Array.from(new Uint8Array(await result.response.arrayBuffer())),
	).toEqual([9, 8]);
});

test('handleHttpSync returns 204 and metering when the room has no diff', async () => {
	const room = new FakeRoom({ diff: null, storageBytes: 64 });
	const { engine } = setup({ 'subject:user-1:rooms:notes': room });

	const result = await engine.handleHttpSync(
		new Request('https://api.test/rooms/notes', {
			method: 'POST',
			body: new Uint8Array([1]),
		}),
		{ roomName: 'subject:user-1:rooms:notes' },
	);

	expect(result.response.status).toBe(204);
	expect(result.storageBytes).toBe(64);
});

test('handleHttpSync rejects oversized payloads before selecting a room', async () => {
	const room = new FakeRoom();
	const { engine, requestedRoomNames } = setup({
		'subject:user-1:rooms:notes': room,
	});

	const result = await engine.handleHttpSync(
		new Request('https://api.test/rooms/notes', {
			method: 'POST',
			body: new Uint8Array([1, 2, 3, 4, 5]),
		}),
		{ roomName: 'subject:user-1:rooms:notes' },
	);

	expect(result.response.status).toBe(413);
	expect(result.storageBytes).toBeNull();
	expect(requestedRoomNames).toEqual([]);
	expect(room.syncBodies).toEqual([]);
});

test('handleWebSocket forwards the raw request to the room WebSocket capability', async () => {
	const room = new FakeRoom();
	const { engine, requestedRoomNames } = setup({
		'subject:user-1:rooms:notes': room,
	});
	const request = new Request(
		'https://api.test/rooms/notes?installationId=device-1',
		{ headers: { upgrade: 'websocket' } },
	);

	const response = await engine.handleWebSocket(request, {
		roomName: 'subject:user-1:rooms:notes',
	});

	expect(response.status).toBe(101);
	expect(requestedRoomNames).toEqual(['subject:user-1:rooms:notes']);
	expect(room.webSocketRequests).toEqual([request]);
});

test('sync engine source has no host auth or billing imports', async () => {
	const source = await Bun.file(
		new URL('./sync-engine.ts', import.meta.url),
	).text();

	expect(source).not.toContain('better-auth');
	expect(source).not.toContain('requireOAuthUser');
	expect(source).not.toContain('createAutumn');
	expect(source).not.toContain('billing');
	expect(source).not.toContain('TokenVerifier');
});
