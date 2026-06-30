/**
 * Tests for `resolveDaemonNodeId`, the daemon's durable per-install identity.
 *
 * The daemon's identity is a durable nanoid (not a signing key), so the
 * invariants that matter are:
 * - the id is a 16-char lowercase nanoid (the same kind browsers mint)
 * - it is persisted under `nodeIdPathFor(root)` (machine-local, under
 *   `runtimeDir()`, never inside the Epicenter root)
 * - stable across calls (a restart keeps the same node, same id file)
 * - distinct per Epicenter root (two folders of the same app are two nodes)
 * - an empty id file fails loud rather than rotating the device's identity
 *   (a fresh id would re-seed the CRDT clientID and fork its identity)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { nodeIdPathFor } from '../daemon/paths.js';
import { resolveDaemonNodeId } from './daemon-node-id.js';

let originalRuntimeDir: string | undefined;
let runtimeRoot: string;
let root: string;

beforeEach(() => {
	// Point the runtime dir at a fresh `/tmp` dir so the id file never leaks into
	// the user's real data dir. `/tmp/...` is short on every POSIX platform,
	// which the socket-path guard in `paths.ts` relies on.
	originalRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;
	runtimeRoot = mkdtempSync('/tmp/daemon-node-id-run-');
	process.env.EPICENTER_RUNTIME_DIR = runtimeRoot;

	root = mkdtempSync('/tmp/daemon-node-id-');
});

afterEach(() => {
	if (originalRuntimeDir === undefined)
		delete process.env.EPICENTER_RUNTIME_DIR;
	else process.env.EPICENTER_RUNTIME_DIR = originalRuntimeDir;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

describe('resolveDaemonNodeId', () => {
	test('returns a nanoid and persists it under nodeIdPathFor', () => {
		const id = resolveDaemonNodeId(root);
		expect(id).toMatch(/^[a-z0-9]{16}$/);
		expect(existsSync(nodeIdPathFor(root))).toBe(true);
		// A second call reuses the same id file, so the identity is durable.
		expect(resolveDaemonNodeId(root)).toBe(id);
	});

	test('is idempotent across calls (a restart keeps the same node)', () => {
		const first = resolveDaemonNodeId(root);
		const second = resolveDaemonNodeId(root);
		expect(second).toBe(first);
	});

	test('gives two roots distinct ids', () => {
		const other = mkdtempSync('/tmp/daemon-node-id-');
		try {
			expect(resolveDaemonNodeId(root)).not.toBe(resolveDaemonNodeId(other));
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	test('fails loud on an empty id file rather than rotating identity', () => {
		// Silently minting a fresh id on an empty file would re-seed the CRDT
		// clientID and fork the device's identity, so corruption is surfaced.
		writeFileSync(nodeIdPathFor(root), '   ');
		expect(() => resolveDaemonNodeId(root)).toThrow();
	});
});
