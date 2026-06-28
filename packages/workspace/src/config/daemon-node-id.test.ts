/**
 * Tests for `resolveDaemonNodeId`, the daemon's durable per-install identity.
 *
 * The daemon's identity is now its iroh device key, so the invariants that
 * matter for the trusted-relay identity model are:
 * - the id is the iroh public key (64-char lowercase hex)
 * - the secret is persisted under `irohKeyPathFor(root)` (machine-local, under
 *   `runtimeDir()`, never inside the Epicenter root)
 * - stable across calls (a restart keeps the same node, same keyfile)
 * - distinct per Epicenter root (two folders of the same app are two nodes)
 * - a corrupt key file fails loud rather than rotating the device's identity
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { irohKeyPathFor } from '../daemon/paths.js';
import { resolveDaemonNodeId } from './daemon-node-id.js';

let originalRuntimeDir: string | undefined;
let runtimeRoot: string;
let root: string;

beforeEach(() => {
	// Point the runtime dir at a fresh `/tmp` dir so the iroh keyfile never
	// leaks into the user's real data dir. `/tmp/...` is short on every POSIX
	// platform, which the socket-path guard in `paths.ts` relies on.
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
	test('returns the iroh pubkey and persists the key under irohKeyPathFor', () => {
		const id = resolveDaemonNodeId(root);
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect(existsSync(irohKeyPathFor(root))).toBe(true);
		// A second call reuses the same keyfile, so the identity is durable.
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

	test('fails loud on a corrupt key file rather than rotating identity', () => {
		// Silently regenerating a device's iroh key on corruption would rotate
		// its identity and de-enroll it, so corruption is surfaced, not healed.
		writeFileSync(irohKeyPathFor(root), 'not json', { mode: 0o600 });
		expect(() => resolveDaemonNodeId(root)).toThrow();
	});
});
