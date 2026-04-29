/**
 * Daemon metadata sidecar: the JSON-on-disk record that lets sibling CLI
 * invocations (and `ps` / `down`) discover an `epicenter up` process without
 * connecting to its socket.
 *
 * One `<runtimeDir>/<dirHash>.meta.json` per running daemon. Written once at
 * startup, unlinked at clean shutdown. Discovery for `ps` / `down --all`
 * goes through {@link enumerateDaemons}; orphan-sweep at startup is the
 * job of `bindOrRecover` in `unix-socket.ts`, which trusts the socket
 * itself rather than the pid in this file.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Metadata sidecar".
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLogger } from 'wellcrafted/logger';

import { metadataPathFor, runtimeDir } from './paths.js';

const log = createLogger('cli/daemon/metadata');

/**
 * On-disk shape of `<dirHash>.meta.json`.
 *
 * `dir` is stored as the absolute, fs-resolved path so two cwd-relative
 * `--dir` arguments resolving to the same workspace match. `configMtime`
 * is captured at startup so `ps` can flag stale daemons whose
 * `epicenter.config.ts` has changed since they booted (Invariant 4: no
 * hot-reload, surface staleness instead).
 *
 * The daemon serves *every* workspace its config exports (Invariant 7);
 * we don't record the loaded set here. Discovery is "ask the daemon
 * which workspaces it serves" via the IPC `status` command, not "read
 * the sidecar." This keeps the metadata file from drifting against a
 * config that's been edited mid-flight.
 */
export type DaemonMetadata = {
	pid: number;
	/** Absolute, fs-resolved `--dir` path. */
	dir: string;
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
 * Enumerate every daemon's metadata under `runtimeDir()`.
 *
 * Reads each `<dirHash>.meta.json` and returns the parsed records, skipping
 * any file that fails to parse. Does NOT filter out stale/orphan entries;
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
