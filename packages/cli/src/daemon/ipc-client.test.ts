import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ipcCall, ipcPing, ipcStream } from './ipc-client';
import { type IpcHandler, startIpcServer } from './ipc-server';

let socketPath: string;
let servers: Awaited<ReturnType<typeof startIpcServer>>[] = [];

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-ipc-client-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
	);
	servers = [];
});

afterEach(async () => {
	for (const server of servers) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe('ipcPing', () => {
	test('returns true against a live ping handler, false after server closes', async () => {
		const handler: IpcHandler = (req, send) => {
			if (req.cmd === 'ping') {
				send({ id: req.id, ok: true, data: 'pong' });
			}
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		expect(await ipcPing(socketPath)).toBe(true);

		await new Promise<void>((resolve) => server.close(() => resolve()));
		// Drop from cleanup list — already closed.
		servers = [];

		expect(await ipcPing(socketPath)).toBe(false);
	});
});

describe('ipcCall', () => {
	test('round-trips args through an echo handler', async () => {
		const handler: IpcHandler = (req, send) => {
			send({ id: req.id, ok: true, data: { echoed: req.args } });
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		const result = await ipcCall<{ echoed: { hello: string } }>(
			socketPath,
			'echo',
			{ hello: 'world' },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).toEqual({ echoed: { hello: 'world' } });
		}
	});

	test('returns NoDaemon when the socket is missing', async () => {
		const missing = join(tmpdir(), `definitely-not-here-${Date.now()}.sock`);
		const result = await ipcCall(missing, 'ping');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.name).toBe('NoDaemon');
		}
	});
});

describe('ipcStream', () => {
	test('yields exactly the streamed values before end:true', async () => {
		const handler: IpcHandler = (req, send) => {
			if (req.cmd === 'count') {
				send({ id: req.id, ok: true, data: 1 });
				send({ id: req.id, ok: true, data: 2 });
				send({ id: req.id, ok: true, data: 3, end: true });
			}
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		const collected: number[] = [];
		for await (const value of ipcStream<number>(socketPath, 'count')) {
			collected.push(value);
		}

		expect(collected).toEqual([1, 2, 3]);
	});
});
