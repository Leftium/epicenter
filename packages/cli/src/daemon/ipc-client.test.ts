import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ipcCall, ipcPing } from './ipc-client';
import {
	type IpcRoutes,
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
	test('returns true against a live ping route, false after server stops', async () => {
		const routes: IpcRoutes = {
			ping: async () => ({ data: 'pong', error: null }),
		};
		const server = await startIpcServer(socketPath, routes);
		servers.push(server);

		expect(await ipcPing(socketPath)).toBe(true);

		server.stop();
		servers = [];

		expect(await ipcPing(socketPath)).toBe(false);
	});

	test('returns false against a missing socket', async () => {
		const missing = join(tmpdir(), `definitely-not-here-${Date.now()}.sock`);
		expect(await ipcPing(missing)).toBe(false);
	});
});

describe('ipcCall', () => {
	test('round-trips args through an echo route', async () => {
		const routes: IpcRoutes = {
			echo: async (args) => ({ data: { echoed: args }, error: null }),
		};
		const server = await startIpcServer(socketPath, routes);
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

	test('returns Timeout when the route hangs past the deadline', async () => {
		const routes: IpcRoutes = {
			slow: () => new Promise(() => {}),
		};
		const server = await startIpcServer(socketPath, routes);
		servers.push(server);

		const result = await ipcCall(socketPath, 'slow', undefined, 100);
		expect(result.data).toBeNull();
		if (result.error !== null) {
			expect(result.error.name).toBe('Timeout');
		}
	});

	test('non-200 (handler throws) surfaces as a SerializedError on the error side', async () => {
		const routes: IpcRoutes = {
			boom: async () => {
				throw new Error('kaboom');
			},
		};
		const server = await startIpcServer(socketPath, routes);
		servers.push(server);

		const result = await ipcCall(socketPath, 'boom');
		expect(result.data).toBeNull();
		if (result.error !== null) {
			expect(result.error.name).toBe('HandlerCrashed');
			expect(result.error.message).toContain('kaboom');
		}
	});

	test('domain Result.error flows through with status 200', async () => {
		const routes: IpcRoutes = {
			refuse: async () => ({
				data: null,
				error: { name: 'NotFound', message: 'gone' },
			}),
		};
		const server = await startIpcServer(socketPath, routes);
		servers.push(server);

		const result = await ipcCall(socketPath, 'refuse');
		expect(result.data).toBeNull();
		if (result.error !== null) {
			expect(result.error.name).toBe('NotFound');
		}
	});
});
