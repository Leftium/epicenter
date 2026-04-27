/**
 * Wave 7 unit tests for `epicenter ps`.
 *
 * `runPs` is driven directly with a stubbed `ipcPing` so we can simulate
 * "alive and responsive" vs "alive but unresponsive" without standing up
 * a real socket server.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeMetadata } from '../daemon/metadata';
import { metadataPathFor, socketPathFor } from '../daemon/paths';
import { runPs } from './ps';

let originalXdg: string | undefined;
let originalHome: string | undefined;
let runtimeRoot: string;
let homeRoot: string;

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	originalHome = process.env.HOME;
	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-ps-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
	homeRoot = mkdtempSync(join(tmpdir(), 'ep-ps-home-'));
	process.env.HOME = homeRoot;
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(homeRoot, { recursive: true, force: true });
});

describe('runPs', () => {
	test('returns empty list when runtime dir has no metadata', async () => {
		const rows = await runPs({ ipcPing: async () => true });
		expect(rows).toEqual([]);
	});

	test('returns alive daemons and unlinks dead-pid orphans', async () => {
		const aliveDir = mkdtempSync(join(tmpdir(), 'ep-ps-alive-'));
		const deadDir = mkdtempSync(join(tmpdir(), 'ep-ps-dead-'));
		try {
			writeMetadata(aliveDir, {
				pid: process.pid,
				dir: aliveDir,
				startedAt: new Date().toISOString(),
				cliVersion: '0.0.0',
				configMtime: 0,
			});
			writeMetadata(deadDir, {
				pid: 99999999,
				dir: deadDir,
				startedAt: new Date().toISOString(),
				cliVersion: '0.0.0',
				configMtime: 0,
			});

			expect(existsSync(metadataPathFor(deadDir))).toBe(true);

			const rows = await runPs({ ipcPing: async () => true });

			expect(rows).toHaveLength(1);
			expect(rows[0]!.dir).toBe(aliveDir);
			expect(rows[0]!.pid).toBe(process.pid);

			// Orphan was swept.
			expect(existsSync(metadataPathFor(deadDir))).toBe(false);
			// Alive metadata still present.
			expect(existsSync(metadataPathFor(aliveDir))).toBe(true);
		} finally {
			rmSync(aliveDir, { recursive: true, force: true });
			rmSync(deadDir, { recursive: true, force: true });
		}
	});

	test('drops alive-pid daemons whose socket is unresponsive', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ep-ps-unresp-'));
		try {
			writeMetadata(dir, {
				pid: process.pid,
				dir,
				startedAt: new Date().toISOString(),
				cliVersion: '0.0.0',
				configMtime: 0,
			});
			const rows = await runPs({ ipcPing: async () => false });
			expect(rows).toEqual([]);
			expect(existsSync(metadataPathFor(dir))).toBe(false);
			void socketPathFor;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
