import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClient } from './client.js';
import { createDaemonServer } from './server.js';
import type { DaemonRuntime } from './types.js';

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

describe('createDaemonServer', () => {
	test('listen is idempotent after the socket is bound', async () => {
		const server = createDaemonServer({
			projectDir: workDir,
			routes: [{ route: 'demo', runtime: makeRuntime() }],
		});

		try {
			const first = await server.listen();
			const second = await server.listen();

			expect(first.error).toBeNull();
			expect(second.error).toBeNull();
		} finally {
			await server.close();
		}
	});

	test('listen serves the configured daemon routes', async () => {
		const server = createDaemonServer({
			projectDir: workDir,
			routes: [{ route: 'demo', runtime: makeRuntime() }],
		});

		try {
			const listenResult = await server.listen();
			expect(listenResult.error).toBeNull();

			const result = await daemonClient(server.socketPath).peers();
			expect(result.error).toBeNull();
			expect(result.data).toEqual([]);
		} finally {
			await server.close();
		}
	});

	test('rejects duplicate routes from embedded callers', () => {
		expect(() =>
			createDaemonServer({
				projectDir: workDir,
				routes: [
					{ route: 'demo', runtime: {} as never },
					{ route: 'demo', runtime: {} as never },
				],
			}),
		).toThrow("duplicate daemon route 'demo'");
	});

	test('rejects invalid routes from embedded callers', () => {
		expect(() =>
			createDaemonServer({
				projectDir: workDir,
				routes: [{ route: 'bad.route', runtime: {} as never }],
			}),
		).toThrow("invalid daemon route 'bad.route'");
	});
});
