/**
 * Daemon Lease Tests
 *
 * Verifies that the SQLite-backed daemon lease is the single ownership
 * primitive for project daemon startup.
 *
 * Key behaviors:
 * - first claimant owns the lease while its transaction stays open
 * - second claimant receives AlreadyRunning while the first lease is held
 * - releasing the first lease allows a later daemon to claim ownership
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimDaemonLease } from './lease.js';

function setup() {
	const oldXdg = process.env.XDG_RUNTIME_DIR;
	const runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-lease-runtime-'));
	const workDir = mkdtempSync(join(tmpdir(), 'ep-lease-dir-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;

	return {
		workDir,
		cleanup() {
			if (oldXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = oldXdg;
			rmSync(runtimeRoot, { recursive: true, force: true });
			rmSync(workDir, { recursive: true, force: true });
		},
	};
}

describe('claimDaemonLease', () => {
	test('second claimant receives AlreadyRunning while first lease is held', () => {
		const { workDir, cleanup } = setup();
		const first = claimDaemonLease(workDir);
		try {
			expect(first.error).toBeNull();
			if (first.error !== null) return;

			const second = claimDaemonLease(workDir);
			expect(second.data).toBeNull();
			expect(second.error?.name).toBe('AlreadyRunning');
		} finally {
			if (first.error === null) first.data.release();
			cleanup();
		}
	});

	test('release allows a later claimant to acquire the lease', () => {
		const { workDir, cleanup } = setup();
		try {
			const first = claimDaemonLease(workDir);
			expect(first.error).toBeNull();
			if (first.error !== null) return;
			expect(existsSync(first.data.leasePath)).toBe(true);
			first.data.release();

			const second = claimDaemonLease(workDir);
			try {
				expect(second.error).toBeNull();
			} finally {
				if (second.error === null) second.data.release();
			}
		} finally {
			cleanup();
		}
	});
});
