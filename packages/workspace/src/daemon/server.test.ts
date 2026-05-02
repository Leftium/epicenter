import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClient } from './client.js';
import { claimDaemonLease, type DaemonLease } from './lease.js';
import { startDaemonServer } from './server.js';
import type { DaemonRuntime } from './types.js';
import { bindUnixSocket } from './unix-socket.js';

let originalXdg: string | undefined;
let runtimeRoot: string;
let workDir: string;

function makeRuntime(): DaemonRuntime {
	return {
		actions: {},
		async [Symbol.asyncDispose]() {
			/* no-op */
		},
		awareness: {
			peers: () => new Map(),
		},
	} as unknown as DaemonRuntime;
}

function claimTestLease(): DaemonLease {
	const lease = claimDaemonLease(workDir);
	expect(lease.error).toBeNull();
	if (lease.error !== null) throw new Error('expected daemon lease');
	return lease.data;
}

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-server-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
	workDir = mkdtempSync(join(tmpdir(), 'ep-server-dir-'));
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

describe('startDaemonServer', () => {
	test('starts the configured daemon routes', async () => {
		const lease = claimTestLease();
		const server = await startDaemonServer({
			lease,
			routes: [{ route: 'demo', runtime: makeRuntime() }],
		});

		try {
			expect(server.error).toBeNull();
			if (server.error !== null) return;

			const result = await daemonClient(server.data.socketPath).peers();
			expect(result.error).toBeNull();
			expect(result.data).toEqual([]);
		} finally {
			if (server.error === null) await server.data.close();
			lease.release();
		}
	});

	test('rejects duplicate routes from embedded callers', async () => {
		const lease = claimTestLease();
		try {
			await expect(
				startDaemonServer({
					lease,
					routes: [
						{ route: 'demo', runtime: {} as never },
						{ route: 'demo', runtime: {} as never },
					],
				}),
			).rejects.toThrow("duplicate daemon route 'demo'");
		} finally {
			lease.release();
		}
	});

	test('rejects invalid routes from embedded callers', async () => {
		const lease = claimTestLease();
		try {
			await expect(
				startDaemonServer({
					lease,
					routes: [{ route: 'bad.route', runtime: {} as never }],
				}),
			).rejects.toThrow("invalid daemon route 'bad.route'");
		} finally {
			lease.release();
		}
	});

	test('returns AlreadyRunning when a responsive legacy socket exists', async () => {
		const lease = claimTestLease();
		const occupant = bindUnixSocket({
			socketPath: lease.socketPath,
			fetch: () => new Response('ok'),
		});
		try {
			const second = await startDaemonServer({
				lease,
				routes: [{ route: 'demo', runtime: makeRuntime() }],
			});
			expect(second.data).toBeNull();
			expect(second.error?.name).toBe('AlreadyRunning');
		} finally {
			await occupant.stop(true).catch(() => {
				// best-effort
			});
			lease.release();
		}
	});
});
