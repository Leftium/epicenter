import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	type DaemonMetadata,
	inspectExistingDaemon,
	isProcessAlive,
	readMetadata,
	unlinkMetadata,
	writeMetadata,
} from './metadata';
import { metadataPathFor, socketPathFor } from './paths';

let originalXdg: string | undefined;
let runtimeRoot: string;
let workDir: string;

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	// Pin the runtime dir to a fresh tmp tree so paths.ts produces predictable,
	// isolated locations for socket + metadata sidecars.
	runtimeRoot = mkdtempSync(join(tmpdir(), 'epicenter-meta-test-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

	// A fake "workspace dir" — its content doesn't matter, only its path.
	workDir = mkdtempSync(join(tmpdir(), 'epicenter-meta-dir-'));
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

const sampleMeta = (overrides: Partial<DaemonMetadata> = {}): DaemonMetadata => ({
	pid: process.pid,
	dir: workDir,
	workspace: 'default',
	deviceId: 'device-abc',
	startedAt: new Date().toISOString(),
	cliVersion: '0.0.0-test',
	configMtime: 0,
	...overrides,
});

describe('readMetadata / writeMetadata / unlinkMetadata', () => {
	test('round-trips write → read', () => {
		const meta = sampleMeta();
		writeMetadata(workDir, meta);
		expect(readMetadata(workDir)).toEqual(meta);
	});

	test('readMetadata returns null when sidecar absent', () => {
		expect(readMetadata(workDir)).toBeNull();
	});

	test('unlinkMetadata removes the sidecar; second call is a no-op', () => {
		writeMetadata(workDir, sampleMeta());
		expect(existsSync(metadataPathFor(workDir))).toBe(true);
		unlinkMetadata(workDir);
		expect(existsSync(metadataPathFor(workDir))).toBe(false);
		// Second unlink should not throw.
		unlinkMetadata(workDir);
	});
});

describe('isProcessAlive', () => {
	test('returns true for the current process', () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	test('returns false for an unused high pid', () => {
		expect(isProcessAlive(99999999)).toBe(false);
	});
});

describe('inspectExistingDaemon', () => {
	test("returns 'clean' when neither metadata nor socket exists", async () => {
		const result = await inspectExistingDaemon(workDir);
		expect(result.state).toBe('clean');
	});

	test("returns 'orphan' for dead-pid metadata + phantom socket; unlinks both", async () => {
		const metaPath = metadataPathFor(workDir);
		const sockPath = socketPathFor(workDir);

		writeMetadata(workDir, sampleMeta({ pid: 99999999 }));
		// A "phantom" socket file — just an empty regular file at the socket
		// path. inspectExistingDaemon should sweep it without trying to ping
		// (the dead pid short-circuits the ping step).
		writeFileSync(sockPath, '');

		expect(existsSync(metaPath)).toBe(true);
		expect(existsSync(sockPath)).toBe(true);

		const result = await inspectExistingDaemon(workDir);
		expect(result.state).toBe('orphan');
		expect(result.pid).toBe(99999999);
		expect(existsSync(metaPath)).toBe(false);
		expect(existsSync(sockPath)).toBe(false);
	});

	test("returns 'orphan' when a phantom socket exists with no metadata", async () => {
		const sockPath = socketPathFor(workDir);
		writeFileSync(sockPath, '');

		const result = await inspectExistingDaemon(workDir);
		expect(result.state).toBe('orphan');
		expect(existsSync(sockPath)).toBe(false);
	});
});
