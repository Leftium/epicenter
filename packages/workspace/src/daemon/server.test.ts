import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonServer } from './server.js';

let originalXdg: string | undefined;
let runtimeRoot: string;
let workDir: string;

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
	test('listen is idempotent for the same server handle', async () => {
		const server = createDaemonServer({ projectDir: workDir });

		try {
			const first = await server.listen();
			const second = await server.listen();

			expect(first.error).toBeNull();
			expect(second.error).toBeNull();
			expect(second.data).toBe(first.data);
		} finally {
			await server.close();
		}
	});

	test('mountRoutes rejects duplicate routes from embedded callers', () => {
		const server = createDaemonServer({ projectDir: workDir });

		expect(() =>
			server.mountRoutes([
				{ route: 'demo', runtime: {} as never },
				{ route: 'demo', runtime: {} as never },
			]),
		).toThrow("duplicate daemon route 'demo'");
	});

	test('mountRoutes rejects invalid routes from embedded callers', () => {
		const server = createDaemonServer({ projectDir: workDir });

		expect(() =>
			server.mountRoutes([{ route: 'bad.route', runtime: {} as never }]),
		).toThrow("invalid daemon route 'bad.route'");
	});
});
