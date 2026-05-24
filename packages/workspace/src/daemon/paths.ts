/**
 * Daemon-process path helpers.
 *
 * Per-project runtime files (socket, metadata sidecar, SQLite lease) live
 * under `runtimeDir()` (a per-user directory built on top of
 * `epicenterEnv.dataDir`). Persistent logs live under `epicenterEnv.logDir`.
 * Every file is keyed by a hash of the daemon's project directory so two
 * daemons on the same machine never collide.
 *
 * For per-workspace data layout (yjs/sqlite/markdown under the project
 * directory's reserved subdir), see `document/workspace-paths.ts`. Different
 * audience, different rationale.
 *
 * Pure helpers: no side effects, no directory creation. The `daemon up`
 * command owns the `mkdir`/`chmod` work; consumers here are free to call
 * these from anywhere without worrying about filesystem mutation.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { epicenterEnv } from '@epicenter/constants/node';

const SAFE_UNIX_SOCKET_PATH_BYTES = 95;

/**
 * Per-user directory for daemon sockets, metadata, and lease files.
 *
 * Default: `<epicenterEnv.dataDir>/run/`, mirroring the systemd/Docker
 * `/run/` convention for transient runtime state. The path stays short
 * enough to fit under the ~104-byte Unix-socket kernel limit on macOS,
 * where `os.tmpdir()` (~48 bytes for `/var/folders/...`) is too long once
 * the per-project socket suffix is appended.
 *
 * `EPICENTER_RUNTIME_DIR` overrides the default. The env var is a workspace
 * test seam: production users do not set it (the default is correct), but
 * test cases set it to a short `mkdtemp` dir under `/tmp/` to isolate from
 * each other. Read on every call so test mutations between cases take
 * effect without re-importing the module.
 */
export function runtimeDir(): string {
	return process.env.EPICENTER_RUNTIME_DIR ?? join(epicenterEnv.dataDir, 'run');
}

/**
 * Stable hash of an absolute, fs-resolved project directory path.
 *
 * Truncated to 16 hex chars (64 bits) so the resulting socket path stays
 * comfortably under the 104-char Unix-socket limit on macOS. Symlinks are
 * resolved via `realpathSync` so two equivalent paths always hash the same.
 * The dir must exist; every production caller hashes a resolved project
 * directory that daemon discovery or project lookup has already accepted.
 */
export function dirHash(dir: string): string {
	return createHash('sha256')
		.update(realpathSync(dir))
		.digest('hex')
		.slice(0, 16);
}

/** Unix-socket path for the daemon serving `dir`. */
export function socketPathFor(dir: string): string {
	const socketPath = join(runtimeDir(), `${dirHash(dir)}.sock`);
	if (Buffer.byteLength(socketPath) > SAFE_UNIX_SOCKET_PATH_BYTES) {
		throw new Error(
			`socketPathFor: resolved path is ${Buffer.byteLength(socketPath)} bytes, ` +
				`exceeds safe Unix socket limit (${SAFE_UNIX_SOCKET_PATH_BYTES}). projectDir=${dir}`,
		);
	}
	return socketPath;
}

/** Metadata JSON sidecar for the daemon serving `dir`. */
export function metadataPathFor(dir: string): string {
	return join(runtimeDir(), `${dirHash(dir)}.meta.json`);
}

/** SQLite lease file for the daemon serving `dir`. */
export function leasePathFor(dir: string): string {
	return join(runtimeDir(), `${dirHash(dir)}.lease.sqlite`);
}

/**
 * Log file for the daemon serving `dir`.
 *
 * Always lives under the user log directory (persistent), never tmpfs, so
 * the operator can read post-mortem logs after a crash or reboot.
 */
export function logPathFor(dir: string): string {
	return join(epicenterEnv.logDir, `${dirHash(dir)}.log`);
}
