/**
 * `daemonClient` is the typed `hc<DaemonApp>` wrapper consumers use. These
 * tests stand up a real Hono app on a real unix socket and exercise the
 * client's transport-error mapping (the typed inputs/outputs are checked
 * by the compiler).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

import { daemonClient, ipcPing } from './ipc-client';
import {
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
		const app = new Hono().post('/ping', (c) =>
			c.json({ data: 'pong', error: null }),
		);
		const server = await startIpcServer(socketPath, app);
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

describe('daemonClient', () => {
	test('ping resolves to the route Result', async () => {
		const app = new Hono().post('/ping', (c) =>
			c.json({ data: 'pong' as const, error: null }),
		);
		const server = await startIpcServer(socketPath, app);
		servers.push(server);

		const result = await daemonClient(socketPath).ping();
		expect(result.error).toBeNull();
		if (result.error === null) expect(result.data).toBe('pong');
	});

	test('NoDaemon when socket is missing', async () => {
		const missing = join(tmpdir(), `definitely-not-here-${Date.now()}.sock`);
		const result = await daemonClient(missing).ping();
		expect(result.data).toBeNull();
		if (result.error !== null) expect(result.error.name).toBe('NoDaemon');
	});

	test('Timeout when route hangs past the deadline', async () => {
		const app = new Hono().post('/ping', () => new Promise(() => {}));
		const server = await startIpcServer(socketPath, app);
		servers.push(server);

		const result = await daemonClient(socketPath, 100).ping();
		expect(result.data).toBeNull();
		if (result.error !== null) expect(result.error.name).toBe('Timeout');
	});

	test('HandlerCrashed on a 500 from the daemon', async () => {
		const app = new Hono().post('/ping', () => {
			throw new Error('kaboom');
		});
		const server = await startIpcServer(socketPath, app);
		servers.push(server);

		const result = await daemonClient(socketPath).ping();
		expect(result.data).toBeNull();
		if (result.error !== null) expect(result.error.name).toBe('HandlerCrashed');
	});

	test('domain Result.error flows through with status 200', async () => {
		// Use the shutdown route shape (no validator) to return a domain error.
		const app = new Hono().post('/shutdown', (c) =>
			c.json({ data: null, error: { name: 'NotFound', message: 'gone' } }),
		);
		const server = await startIpcServer(socketPath, app);
		servers.push(server);

		const result = await daemonClient(socketPath).shutdown();
		expect(result.data).toBeNull();
		if (result.error !== null) expect(result.error.name).toBe('NotFound');
	});
});
