import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	type IpcRoutes,
	type IpcServerHandle,
	startIpcServer,
	unlinkSocketFile,
} from './ipc-server';

let socketPath: string;
let servers: IpcServerHandle[] = [];

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
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

async function post(
	socketPath: string,
	cmd: string,
	body?: unknown,
): Promise<Response> {
	return fetch(`http://daemon/${cmd}`, {
		unix: socketPath,
		method: 'POST',
		body: body === undefined ? '' : JSON.stringify(body),
	});
}

describe('startIpcServer', () => {
	test('round-trip: ping → pong wrapped in Result', async () => {
		const routes: IpcRoutes = {
			ping: async () => ({ data: 'pong', error: null }),
		};
		const server = await startIpcServer(socketPath, routes);
		servers.push(server);

		const res = await post(socketPath, 'ping');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ data: 'pong', error: null });
	});

	test('handler args round-trip via JSON body', async () => {
		const routes: IpcRoutes = {
			echo: async (args) => ({ data: { echoed: args }, error: null }),
		};
		const server = await startIpcServer(socketPath, routes);
		servers.push(server);

		const res = await post(socketPath, 'echo', { hello: 'world' });
		expect(await res.json()).toEqual({
			data: { echoed: { hello: 'world' } },
			error: null,
		});
	});

	test('thrown handler surfaces as 500 with HandlerCrashed body', async () => {
		const routes: IpcRoutes = {
			boom: async () => {
				throw new Error('kaboom');
			},
		};
		const server = await startIpcServer(socketPath, routes);
		servers.push(server);

		const res = await post(socketPath, 'boom');
		expect(res.status).toBe(500);
		const body = (await res.json()) as { name: string; message: string };
		expect(body.name).toBe('HandlerCrashed');
		expect(body.message).toContain('kaboom');
	});

	test('domain errors flow through as 200 with Result.error populated', async () => {
		const routes: IpcRoutes = {
			refuse: async () => ({
				data: null,
				error: { name: 'NotFound', message: 'gone' },
			}),
		};
		const server = await startIpcServer(socketPath, routes);
		servers.push(server);

		const res = await post(socketPath, 'refuse');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: null,
			error: { name: 'NotFound', message: 'gone' },
		});
	});

	test('unknown route returns 404', async () => {
		const server = await startIpcServer(socketPath, {
			ping: async () => ({ data: 'pong', error: null }),
		});
		servers.push(server);

		const res = await post(socketPath, 'nope');
		expect(res.status).toBe(404);
	});

	test('socket is created with mode 0600', async () => {
		const server = await startIpcServer(socketPath, {});
		servers.push(server);

		const mode = statSync(socketPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test('stopping the server + unlinkSocketFile sweeps the socket file', async () => {
		const server = await startIpcServer(socketPath, {});
		expect(existsSync(socketPath)).toBe(true);

		server.stop();
		unlinkSocketFile(socketPath);
		expect(existsSync(socketPath)).toBe(false);
	});
});
