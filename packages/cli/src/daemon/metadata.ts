/**
 * Daemon metadata sidecar — the JSON-on-disk record that lets sibling CLI
 * invocations (and `ps` / `down`) discover an `epicenter up` process without
 * connecting to its socket.
 *
 * One `<runtimeDir>/<dirHash>.meta.json` per running daemon. Written once at
 * startup, unlinked at clean shutdown, and inspected at every fresh `up` to
 * decide whether to bail (live daemon already serving this `--dir`) or to
 * sweep an orphan (the previous daemon was `kill -9`'d and never cleaned up).
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Metadata sidecar".
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLogger } from 'wellcrafted/logger';

import { ipcPing } from './ipc-client.js';
import { metadataPathFor, runtimeDir, socketPathFor } from './paths.js';

const log = createLogger('cli/daemon/metadata');

/**
 * On-disk shape of `<dirHash>.meta.json`.
 *
 * `dir` is stored as the absolute, fs-resolved path so two cwd-relative
 * `--dir` arguments resolving to the same workspace match. `configMtime`
 * is captured at startup so `ps` can flag stale daemons whose
 * `epicenter.config.ts` has changed since they booted (Invariant 4: no
 * hot-reload — surface staleness instead).
 */
export type DaemonMetadata = {
	pid: number;
	/** Absolute, fs-resolved `--dir` path. */
	dir: string;
	/** Workspace entry name selected at daemon start. */
	workspace: string;
	deviceId: string;
	/** ISO 8601 timestamp. */
	startedAt: string;
	cliVersion: string;
	/** `epicenter.config.ts` mtime in ms at daemon start. */
	configMtime: number;
};

/** Read metadata for `dir`, or `null` if the sidecar is absent or unreadable. */
export function readMetadata(dir: string): DaemonMetadata | null {
	return readMetadataFromPath(metadataPathFor(dir));
}

/**
 * Read a metadata sidecar by absolute file path. Used when enumerating
 * `<runtimeDir>/*.meta.json` (e.g. `epicenter down --all` and `epicenter ps`),
 * where the caller knows the file path but not the workspace dir it maps to.
 */
export function readMetadataFromPath(path: string): DaemonMetadata | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, 'utf8');
		return JSON.parse(raw) as DaemonMetadata;
	} catch (cause) {
		log.debug('failed to read daemon metadata', { path, cause });
		return null;
	}
}

/** Write metadata for `dir` atomically (single-writer; the daemon owns it). */
export function writeMetadata(dir: string, meta: DaemonMetadata): void {
	const path = metadataPathFor(dir);
	writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

/** Best-effort unlink of the metadata sidecar; silent if already gone. */
export function unlinkMetadata(dir: string): void {
	const path = metadataPathFor(dir);
	if (!existsSync(path)) return;
	try {
		unlinkSync(path);
	} catch (cause) {
		log.debug('failed to unlink daemon metadata', { path, cause });
	}
}

/**
 * True iff a process with `pid` exists and is reachable from the current
 * user. Uses `kill -0`, which sends no signal but performs the same
 * permission/existence check the kernel does for a real signal.
 *
 * - `ESRCH` → no such process → `false`.
 * - `EPERM` → process exists but is owned by another uid → `true`. (For our
 *   case `kill -0` shouldn't `EPERM` since the daemon and the inspector
 *   share a uid, but we honor the kernel's "exists" signal anyway.)
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		if (code === 'EPERM') return true;
		return false;
	}
}

/**
 * Outcome of {@link inspectExistingDaemon} — what `up` should do at startup.
 *
 * - `'in-use'`: a live daemon already owns this `--dir`. Caller exits 1.
 * - `'orphan'`: stale metadata and/or socket from a dead daemon. Caller has
 *   already had both files unlinked on its behalf and may proceed.
 * - `'clean'`: nothing on disk. Caller proceeds.
 */
export type StartupState = 'in-use' | 'orphan' | 'clean';

/**
 * Decide what `up` should do with leftover socket/metadata files for `dir`.
 *
 * Liveness check is two-step: pid alive (cheap, local) AND IPC ping responds
 * (proves the daemon is actually serving, not just a recycled pid). Anything
 * less than both is treated as orphan and swept — the orphan branch unlinks
 * the metadata and socket files before returning so the caller can proceed
 * straight to a fresh bind.
 *
 * The `'in-use'` branch is exercised end-to-end in Wave 5's `up` tests; here
 * we only cover `'clean'` and `'orphan'` since `'in-use'` requires a real
 * listening daemon to ping.
 */
export async function inspectExistingDaemon(
	dir: string,
): Promise<{ state: StartupState; pid?: number }> {
	const sockPath = socketPathFor(dir);
	const meta = readMetadata(dir);

	// Nothing on disk at all → fresh start.
	if (!meta && !existsSync(sockPath)) {
		return { state: 'clean' };
	}

	// Socket file but no metadata → orphan from a crashed daemon.
	if (!meta) {
		sweepOrphan(dir);
		return { state: 'orphan' };
	}

	// Metadata present but pid is dead → orphan, sweep both.
	if (!isProcessAlive(meta.pid)) {
		sweepOrphan(dir);
		return { state: 'orphan', pid: meta.pid };
	}

	// Pid is alive, but only a real ping proves the daemon is actually serving.
	const responsive = await ipcPing(sockPath);
	if (!responsive) {
		sweepOrphan(dir);
		return { state: 'orphan', pid: meta.pid };
	}

	return { state: 'in-use', pid: meta.pid };
}

/**
 * Enumerate every daemon's metadata under `runtimeDir()`.
 *
 * Reads each `<dirHash>.meta.json` and returns the parsed records, skipping
 * any file that fails to parse. Does NOT filter out stale/orphan entries —
 * the caller decides whether to ping, sweep, or display them as-is. This
 * keeps `enumerateDaemons` cheap and predictable; consumers like `ps` add
 * the liveness check, while consumers like `down --all` only need the pid
 * to send a SIGTERM.
 */
export function enumerateDaemons(): DaemonMetadata[] {
	const root = runtimeDir();
	if (!existsSync(root)) return [];
	const result: DaemonMetadata[] = [];
	for (const name of readdirSync(root)) {
		if (!name.endsWith('.meta.json')) continue;
		const meta = readMetadataFromPath(join(root, name));
		if (meta) result.push(meta);
	}
	return result;
}

/**
 * Unlink the metadata sidecar AND the socket file for `dir`. Used by every
 * caller that wants to clean up after a dead daemon (orphan-detection at
 * `up` startup, `ps` liveness sweep, `down` SIGTERM fallback).
 */
export function sweepOrphan(dir: string): void {
	unlinkMetadata(dir);
	const sockPath = socketPathFor(dir);
	if (existsSync(sockPath)) {
		try {
			unlinkSync(sockPath);
		} catch (cause) {
			log.debug('failed to unlink orphan socket', { sockPath, cause });
		}
	}
}
