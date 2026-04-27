import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ipcCall, ipcPing, ipcStream } from './ipc-client';
import {
	type IpcHandler,
	type IpcServerHandle,
	startIpcServer,
} from './ipc-server';

let socketPath: string;
let servers: IpcServerHandle[] = [];

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-ipc-client-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
	);
	servers = [];
});

afterEach(() => {
	for (const server of servers) {
		try {
			server.stop();
		} catch {
			// already stopped
		}
	}
});

describe('ipcPing', () => {
	test('returns true against a live ping handler, false after server closes', async () => {
		const handler: IpcHandler = (req, send) => {
			if (req.cmd === 'ping') {
				send({ id: req.id, data: 'pong', error: null });
			}
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		expect(await ipcPing(socketPath)).toBe(true);

		server.stop();
		// Drop from cleanup list — already stopped.
		servers = [];

		expect(await ipcPing(socketPath)).toBe(false);
	});
});

describe('ipcCall', () => {
	test('round-trips args through an echo handler', async () => {
		const handler: IpcHandler = (req, send) => {
			send({ id: req.id, data: { echoed: req.args }, error: null });
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		const result = await ipcCall<{ echoed: { hello: string } }>(
			socketPath,
			'echo',
			{ hello: 'world' },
		);

		expect(result.error).toBeNull();
		if (result.error === null) {
			expect(result.data).toEqual({ echoed: { hello: 'world' } });
		}
	});

	test('returns NoDaemon when the socket is missing', async () => {
		const missing = join(tmpdir(), `definitely-not-here-${Date.now()}.sock`);
		const result = await ipcCall(missing, 'ping');
		expect(result.data).toBeNull();
		if (result.error !== null) {
			expect(result.error.name).toBe('NoDaemon');
		}
	});
});

describe('ipcStream', () => {
	test('yields exactly the streamed values before end:true', async () => {
		const handler: IpcHandler = (req, send) => {
			if (req.cmd === 'count') {
				send({ id: req.id, data: 1, error: null });
				send({ id: req.id, data: 2, error: null });
				send({ id: req.id, data: 3, error: null, end: true });
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
