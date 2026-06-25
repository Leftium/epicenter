/**
 * Live-socket integration test for the Bun room backend.
 *
 * Boots a real `Bun.serve` wired to {@link createBunRooms}, then drives it
 * with real `WebSocket` clients. This exercises the exact path the stub test
 * cannot: `server.upgrade(request, { data })` resolving the WS-upgrade
 * impedance (Bun cannot return a 101 from `fetch`), the top-level `websocket`
 * handler delivering frames to `RoomCore`, and real binary/text frames flowing
 * back over the wire. It is the Bun half of the "a room syncs over WebSocket"
 * proof (ADR-0065 Wave 4); auth is omitted here on purpose, since this asserts
 * the transport, not the gate (the gate is proven by the route's own tests).
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asUserId } from '@epicenter/auth';
import { encodeSyncUpdate, MAIN_SUBPROTOCOL } from '@epicenter/sync';
import type { Server } from 'bun';
import * as Y from 'yjs';
import { type BunRoomSocketData, createBunRooms } from './registry.js';

const ROOM = 'owners/u1/rooms/r1';

let dir: string;
let server: Server<BunRoomSocketData>;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'node-rooms-live-'));
	const bunRooms = createBunRooms({ dir });
	server = Bun.serve({
		port: 0, // ephemeral
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/ws') {
				const nodeId = url.searchParams.get('nodeId') ?? '';
				return bunRooms.rooms.get(ROOM).handleUpgrade({
					request: req,
					userId: asUserId('u1'),
					nodeId,
				});
			}
			return new Response('ok');
		},
		websocket: bunRooms.websocket,
	});
	bunRooms.bindServer(server);
});

afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

type Frame = { text?: string; binary?: Uint8Array };

/** Open a client, collecting every frame it receives. */
async function openClient(nodeId: string): Promise<{
	ws: WebSocket;
	frames: Frame[];
}> {
	const ws = new WebSocket(
		`ws://localhost:${server.port}/ws?nodeId=${nodeId}`,
		[MAIN_SUBPROTOCOL],
	);
	ws.binaryType = 'arraybuffer';
	const frames: Frame[] = [];
	ws.onmessage = (e) => {
		if (typeof e.data === 'string') frames.push({ text: e.data });
		else frames.push({ binary: new Uint8Array(e.data as ArrayBuffer) });
	};
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error(`socket ${nodeId} errored`));
	});
	return { ws, frames };
}

/** Poll until `pred` holds or the deadline passes. */
async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

function presenceNodeIds(frames: Frame[]): string[][] {
	return frames
		.filter((f) => f.text)
		.map((f) => JSON.parse(f.text as string))
		.filter((m) => m.type === 'presence')
		.map((m: { peers: { nodeId: string }[] }) => m.peers.map((p) => p.nodeId));
}

test('a real WebSocket upgrade syncs presence and a binary update across clients', async () => {
	// Client A connects: it gets a binary SyncStep1 and an empty presence list.
	const a = await openClient('A');
	await waitFor(() => a.frames.some((f) => f.binary));
	await waitFor(() => presenceNodeIds(a.frames).length > 0);
	expect(presenceNodeIds(a.frames)[0]).toEqual([]);

	// Client B connects: B's directed presence lists A, and A is rebroadcast B.
	const b = await openClient('B');
	await waitFor(() => presenceNodeIds(b.frames).some((p) => p.includes('A')));
	await waitFor(() => presenceNodeIds(a.frames).some((p) => p.includes('B')));

	// A sends a Yjs update; B receives it as a binary frame, A does not echo.
	const aBinaryBefore = a.frames.filter((f) => f.binary).length;
	const bBinaryBefore = b.frames.filter((f) => f.binary).length;
	const doc = new Y.Doc();
	doc.getMap('data').set('hello', 'world');
	a.ws.send(encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(doc) }));

	await waitFor(() => b.frames.filter((f) => f.binary).length > bBinaryBefore);
	expect(a.frames.filter((f) => f.binary).length).toBe(aBinaryBefore);

	a.ws.close();
	b.ws.close();
});
