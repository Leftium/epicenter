/**
 * Wave 7 unit tests for `epicenter down`.
 *
 * Drives `runDown` directly with a stubbed `shutdown` and `kill`, so we
 * never touch a real daemon process. The cross-process e2e for shutdown
 * lives in Wave 8.
 *
 * Cases:
 *   1. Graceful shutdown when the daemon answers `shutdown` ok.
 *   2. SIGTERM fallback when shutdown returns a transport error.
 *   3. `--all` enumerates every metadata file under runtimeDir.
 *   4. Missing project metadata reports `'absent'` (no throw).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMetadata } from '@epicenter/workspace/node';
import { Err, Ok } from 'wellcrafted/result';
import { runDown } from './down';

let originalXdg: string | undefined;
let originalHome: string | undefined;
let runtimeRoot: string;
let homeRoot: string;
let workDir: string;

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	originalHome = process.env.HOME;

	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-down-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

	homeRoot = mkdtempSync(join(tmpdir(), 'ep-down-home-'));
	process.env.HOME = homeRoot;

	workDir = mkdtempSync(join(tmpdir(), 'ep-down-dir-'));
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

describe('runDown: graceful', () => {
	test('reports graceful when shutdown returns ok', async () => {
		writeMetadata(workDir, {
			pid: process.pid,
			dir: workDir,
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			configMtime: 0,
		});

		const result = await runDown(
			{ projectDir: workDir, all: false },
			{
				shutdown: async () => Ok(null),
				kill: () => {
					throw new Error('kill should not be called on graceful path');
				},
			},
		);

		expect(result.outcomes).toHaveLength(1);
		expect(result.outcomes[0]!.kind).toBe('graceful');
	});
});

describe('runDown: SIGTERM fallback', () => {
	test('falls through to kill when shutdown returns transport error', async () => {
		writeMetadata(workDir, {
			pid: process.pid,
			dir: workDir,
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			configMtime: 0,
		});

		const killed: Array<{ pid: number; sig: string }> = [];
		const result = await runDown(
			{ projectDir: workDir, all: false },
			{
				shutdown: async () =>
					Err({ name: 'Timeout', message: 'timeout after 1000ms' }),
				kill: (pid, sig) => {
					killed.push({ pid, sig });
				},
			},
		);

		expect(result.outcomes[0]!.kind).toBe('sigterm');
		expect(killed).toEqual([{ pid: process.pid, sig: 'SIGTERM' }]);
	});
});

describe('runDown: absent', () => {
	test('reports absent when no project metadata file exists', async () => {
		const result = await runDown(
			{ projectDir: workDir, all: false },
			{
				shutdown: async () => {
					throw new Error(
						'shutdown should not be called when metadata is absent',
					);
				},
				kill: () => {
					throw new Error('kill should not be called when metadata is absent');
				},
			},
		);
		expect(result.outcomes).toHaveLength(1);
		expect(result.outcomes[0]!.kind).toBe('absent');
	});
});

describe('runDown --all', () => {
	test('shuts down every metadata file in parallel', async () => {
		const dirA = mkdtempSync(join(tmpdir(), 'ep-down-a-'));
		const dirB = mkdtempSync(join(tmpdir(), 'ep-down-b-'));
		try {
			writeMetadata(dirA, {
				pid: process.pid,
				dir: dirA,
				startedAt: new Date().toISOString(),
				cliVersion: '0.0.0',
				configMtime: 0,
			});
			writeMetadata(dirB, {
				pid: process.pid,
				dir: dirB,
				startedAt: new Date().toISOString(),
				cliVersion: '0.0.0',
				configMtime: 0,
			});

			const result = await runDown(
				{ projectDir: '.', all: true },
				{
					shutdown: async () => Ok(null),
					kill: () => {},
				},
			);
			expect(result.outcomes).toHaveLength(2);
			expect(result.outcomes.every((o) => o.kind === 'graceful')).toBe(true);
		} finally {
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	});
});
