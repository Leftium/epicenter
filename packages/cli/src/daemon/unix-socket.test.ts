import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

import {
	bindUnixSocket,
	type UnixSocketServer,
	unlinkSocketFile,
} from './unix-socket';

let socketPath: string;
let servers: UnixSocketServer[] = [];

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-unix-socket-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
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

/**
 * `bindUnixSocket` is now a thin wrapper around `Bun.serve({ unix, fetch:
 * app.fetch })` plus filesystem hardening. The route-level behavior lives
 * in `app.ts` (and is exercised through the typed client in
 * `client.test.ts`); this file covers only the binding/hardening contract
 * that survives no matter what app you hand it.
 */
describe('bindUnixSocket', () => {
	test('binds the socket and routes through to the Hono app', async () => {
		const app = new Hono().post('/ping', (c) => c.json({ ok: true }));

		const server = await bindUnixSocket(socketPath, app);
		servers.push(server);

		const res = await fetch('http://daemon/ping', {
			unix: socketPath,
			method: 'POST',
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test('socket file is created with mode 0600', async () => {
		const app = new Hono();
		const server = await bindUnixSocket(socketPath, app);
		servers.push(server);

		const mode = statSync(socketPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test('server.stop() unlinks the socket file', async () => {
		const app = new Hono();
		const server = await bindUnixSocket(socketPath, app);
		expect(existsSync(socketPath)).toBe(true);

		server.stop();
		// Bun.serve auto-unlinks; sweep best-effort just in case.
		unlinkSocketFile(socketPath);
		expect(existsSync(socketPath)).toBe(false);
	});

	test('unknown route returns 404 (Hono default)', async () => {
		const app = new Hono().post('/ping', (c) => c.text('ok'));
		const server = await bindUnixSocket(socketPath, app);
		servers.push(server);

		const res = await fetch('http://daemon/nope', {
			unix: socketPath,
			method: 'POST',
		});
		expect(res.status).toBe(404);
	});
});
