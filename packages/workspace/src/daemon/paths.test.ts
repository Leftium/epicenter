import { afterEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { dirHash, socketPathFor } from './paths.js';

describe('daemon/paths', () => {
	const originalRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;

	afterEach(() => {
		if (originalRuntimeDir === undefined) {
			delete process.env.EPICENTER_RUNTIME_DIR;
		} else {
			process.env.EPICENTER_RUNTIME_DIR = originalRuntimeDir;
		}
	});

	test('dirHash of a relative path equals the hash of its realpath', () => {
		// `tmpdir()` may resolve through a symlink (e.g. /tmp -> /private/tmp on
		// macOS); dirHash should normalize via realpathSync so equivalent inputs
		// hash identically.
		const symlinked = tmpdir();
		const real = realpathSync(symlinked);
		expect(dirHash(symlinked)).toBe(dirHash(real));
	});

	test('socketPathFor stays under the configured safe Unix socket limit', () => {
		const dir = realpathSync(tmpdir());
		expect(Buffer.byteLength(socketPathFor(dir))).toBeLessThanOrEqual(95);
	});

	test('socketPathFor rejects unsafe socket paths', () => {
		// A runtime dir long enough that any per-project socket path overflows
		// the guard, independent of how short os.tmpdir() is in the test
		// environment. Deriving the long path from tmpdir() was flaky: it only
		// overflowed when TMPDIR was already long (macOS /var/folders), and
		// passed under a short TMPDIR (e.g. /tmp). socketPathFor only reads
		// EPICENTER_RUNTIME_DIR and never stats it, so a synthetic path is fine.
		process.env.EPICENTER_RUNTIME_DIR = `/run/${'too-long-for-a-unix-domain-socket-'.repeat(4)}`;
		expect(() => socketPathFor(tmpdir())).toThrow(
			/exceeds safe Unix socket limit/,
		);
	});
});
