/**
 * Path builders for the long-lived `epicenter up` daemon.
 *
 * Pure helpers — no side effects, no directory creation. The `up` command
 * (Wave 5) owns the `mkdir`/`chmod` work; consumers here are free to call
 * these from anywhere without worrying about filesystem mutation.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § Socket location.
 */

import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { epicenterPaths } from '../auth/paths.js';

/**
 * Resolve the runtime directory for daemon sockets and metadata.
 *
 * - Linux with `XDG_RUNTIME_DIR` → `$XDG_RUNTIME_DIR/epicenter` (tmpfs,
 *   reboot-cleaned by the OS).
 * - macOS / Windows / Linux without XDG → `~/.epicenter/run` (orphan
 *   cleanup at `up` startup substitutes for the missing tmpfs reset).
 */
export function runtimeDir(): string {
	if (process.env.XDG_RUNTIME_DIR) {
		return join(process.env.XDG_RUNTIME_DIR, 'epicenter');
	}
	return join(epicenterPaths.home(), 'run');
}

/**
 * Stable hash of an absolute, fs-resolved `--dir` path.
 *
 * Truncated to 16 hex chars (64 bits) so the resulting socket path stays
 * comfortably under the 104-char Unix-socket limit on macOS. Symlinks are
 * resolved via `realpathSync` so two equivalent paths always hash the same;
 * a non-existent path falls back to the literal input (the directory may
 * not exist yet at hash time).
 */
export function dirHash(dir: string): string {
	const abs = existsSync(dir) ? realpathSync(dir) : dir;
	return createHash('sha256').update(abs).digest('hex').slice(0, 16);
}

/** Unix-socket path for the daemon serving `dir`. */
export function socketPathFor(dir: string): string {
	return join(runtimeDir(), `${dirHash(dir)}.sock`);
}

/** Metadata JSON sidecar (`pid`, `deviceId`, `workspace`, ...) for the daemon serving `dir`. */
export function metadataPathFor(dir: string): string {
	return join(runtimeDir(), `${dirHash(dir)}.meta.json`);
}

/**
 * Log file for the daemon serving `dir`.
 *
 * Always lives under `~/.epicenter/log/` (persistent) — never tmpfs, so
 * the operator can read post-mortem logs after a crash or reboot.
 */
export function logPathFor(dir: string): string {
	return join(epicenterPaths.home(), 'log', `${dirHash(dir)}.log`);
}
