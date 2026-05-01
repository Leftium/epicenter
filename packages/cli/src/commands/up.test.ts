/**
 * Wave 5 unit-level tests for `epicenter up`.
 *
 * These tests run `runUp` in-process with a fake `DaemonRuntime` /
 * `SyncAttachment` so we never spawn a child or call `process.exit`. The
 * cross-process e2e (real CLI binary, real relay) lands in Wave 8.
 *
 * Cases (per the brief):
 *   1. Happy path: bindUnixSocket is called, metadata is written, ping replies "pong".
 *   2. Already-running: pre-write metadata for `process.pid` + a real listening socket;
 *      runUp throws "daemon already running (pid=X)".
 *   3. Orphan: pre-write metadata for a dead pid + phantom socket; runUp proceeds
 *      cleanly (no throw).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	DaemonRouteDefinition,
	DaemonRuntime,
	StartedDaemonRoute,
} from '@epicenter/workspace/daemon';
import {
	bindUnixSocket,
	metadataPathFor,
	pingDaemon,
	socketPathFor,
	writeMetadata,
} from '@epicenter/workspace/node';
import { Ok } from 'wellcrafted/result';
import type { LoadedDaemonConfig } from '../load-config';
import { runUp } from './up';

let originalXdg: string | undefined;
let runtimeRoot: string;
let workDir: string;
let homeRoot: string;
let originalHome: string | undefined;

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	originalHome = process.env.HOME;

	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-up-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

	homeRoot = mkdtempSync(join(tmpdir(), 'ep-home-'));
	process.env.HOME = homeRoot;

	workDir = mkdtempSync(join(tmpdir(), 'ep-dir-'));
	// Seed an empty config so readConfigMtime succeeds (the file exists path).
	writeFileSync(join(workDir, 'epicenter.config.ts'), 'export {};\n');
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;

	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(homeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

function makeFakeWorkspace(): DaemonRuntime {
	return {
		actions: {},
		async [Symbol.asyncDispose]() {
			/* no-op */
		},
		sync: {
			whenConnected: new Promise(() => {
				/* sync connects in the background */
			}),
			whenDisposed: Promise.resolve(),
			status: { phase: 'connected', hasLocalChanges: false },
			onStatusChange: () => () => {},
			// Unused fields; cast through unknown to keep the fake minimal.
		} as unknown as DaemonRuntime['sync'],
		presence: {
			peers: () => new Map(),
			observe: () => () => {},
			waitForPeer: async () => ({
				data: null,
				error: {
					name: 'PeerMiss',
					message: 'missing peer',
					peerTarget: 'missing',
					sawPeers: false,
					waitMs: 1,
					emptyReason: null,
				},
			}),
		} as unknown as DaemonRuntime['presence'],
		rpc: {
			rpc: async () => ({ data: null, error: null }),
		} as unknown as DaemonRuntime['rpc'],
	};
}

function makeFakeConfig(runtime: DaemonRuntime): LoadedDaemonConfig {
	const routes: DaemonRouteDefinition[] = [
		{
			route: 'default',
			start: async () => runtime,
		},
	];
	return {
		projectDir: workDir as LoadedDaemonConfig['projectDir'],
		configPath: join(workDir, 'epicenter.config.ts'),
		routes,
	};
}

describe('runUp: happy path', () => {
	test('writes metadata, binds socket, replies to ping', async () => {
		const workspace = makeFakeWorkspace();
		const config = makeFakeConfig(workspace);

		const { data: handle, error } = await runUp(
			{
				projectDir: workDir,
				quiet: true,
			},
			{
				loadDaemonConfig: async () => Ok(config),
			},
		);
		expect(error).toBeNull();
		if (error) throw new Error('runUp failed unexpectedly');

		// Metadata was written.
		expect(existsSync(metadataPathFor(workDir))).toBe(true);
		expect(handle.metadata.pid).toBe(process.pid);
		expect(handle.runtimes).toHaveLength(1);
		expect(handle.runtimes[0]?.route).toBe('default');

		// Socket is bound; ping it via a fresh connect using the real client.
		const sockPath = socketPathFor(workDir);
		expect(existsSync(sockPath)).toBe(true);
		const ok = await pingDaemon(sockPath, 1000);
		expect(ok).toBe(true);

		await handle.teardown();
		// Cleanup: metadata and socket gone.
		expect(existsSync(metadataPathFor(workDir))).toBe(false);
		expect(existsSync(sockPath)).toBe(false);
	});
});

describe('runUp: already running', () => {
	test('returns AlreadyRunning when a live daemon is detected', async () => {
		const sockPath = socketPathFor(workDir);
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

		const { Hono } = await import('hono');
		const { Ok } = await import('wellcrafted/result');
		const app = new Hono().post('/ping', (c) => c.json(Ok('pong' as const)));
		const server = await bindUnixSocket(sockPath, app);

		writeMetadata(workDir, {
			pid: process.pid,
			dir: workDir,
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			configMtime: 0,
		});

		let loadCalls = 0;
		let startCalls = 0;
		try {
			const { error } = await runUp(
				{
					projectDir: workDir,
					quiet: true,
				},
				{
					loadDaemonConfig: async () => {
						loadCalls++;
						return Ok(makeFakeConfig(makeFakeWorkspace()));
					},
					startDaemonRoutes: async () => {
						startCalls++;
						return Ok([] satisfies StartedDaemonRoute[]);
					},
				},
			);
			expect(error?.name).toBe('AlreadyRunning');
			if (error?.name === 'AlreadyRunning') {
				expect(error.pid).toBe(process.pid);
			}
			expect(loadCalls).toBe(0);
			expect(startCalls).toBe(0);
		} finally {
			server.stop();
		}
	});

	test('does not import config when a live daemon is detected', async () => {
		const sockPath = socketPathFor(workDir);
		const { Hono } = await import('hono');
		const { Ok } = await import('wellcrafted/result');
		const app = new Hono().post('/ping', (c) => c.json(Ok('pong' as const)));
		const server = await bindUnixSocket(sockPath, app);

		writeFileSync(
			join(workDir, 'epicenter.config.ts'),
			`globalThis.__upImportSideEffects = (globalThis.__upImportSideEffects ?? 0) + 1;
			export default { daemon: { routes: [] } };`,
		);
		delete (globalThis as { __upImportSideEffects?: number })
			.__upImportSideEffects;

		try {
			const { error } = await runUp({
				projectDir: workDir,
				quiet: true,
			});

			expect(error?.name).toBe('AlreadyRunning');
			expect(
				(globalThis as { __upImportSideEffects?: number })
					.__upImportSideEffects,
			).toBeUndefined();
		} finally {
			server.stop();
			delete (globalThis as { __upImportSideEffects?: number })
				.__upImportSideEffects;
		}
	});
});

describe('runUp: orphan path', () => {
	test('proceeds cleanly when metadata pid is dead and socket is phantom', async () => {
		const sockPath = socketPathFor(workDir);
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

		// Phantom (regular file, not a real socket) + dead-pid metadata.
		writeFileSync(sockPath, '');
		writeMetadata(workDir, {
			pid: 99999999,
			dir: workDir,
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			configMtime: 0,
		});

		const workspace = makeFakeWorkspace();
		const config = makeFakeConfig(workspace);

		const { data: handle, error } = await runUp(
			{
				projectDir: workDir,
				quiet: true,
			},
			{
				loadDaemonConfig: async () => Ok(config),
			},
		);
		expect(error).toBeNull();
		if (error) throw new Error('runUp failed unexpectedly');

		// Daemon came up; fresh metadata for *this* pid was written.
		expect(handle.metadata.pid).toBe(process.pid);
		expect(existsSync(socketPathFor(workDir))).toBe(true);

		await handle.teardown();
	});
});
