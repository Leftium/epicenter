/**
 * Project daemon lease.
 *
 * The lease is the single ownership primitive for daemon startup and lifetime.
 * Sockets are IPC endpoints, metadata is diagnostics, and ping is liveness.
 * None of those decide ownership.
 *
 * SQLite gives us a cross-platform OS-backed lock through an open write
 * transaction. `BEGIN IMMEDIATE` fails with `SQLITE_BUSY` when another process
 * already holds the lease, and the OS releases the lock when the process dies
 * and the database handle closes.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Ok, type Result } from 'wellcrafted/result';

import { readMetadata } from './metadata.js';
import { leasePathFor, socketPathFor } from './paths.js';
import {
	StartupError,
	type StartupError as StartupErrorType,
} from './unix-socket.js';

export type DaemonLease = {
	/** Filesystem-resolved absolute path that scopes this daemon. */
	readonly projectDir: string;
	/** SQLite file whose open write transaction owns the daemon lease. */
	readonly leasePath: string;
	/** Filesystem path of the unix socket this daemon binds. */
	readonly socketPath: string;
	/** Release the daemon lease. Idempotent. */
	release(): void;
};

export function claimDaemonLease(
	projectDir: string,
): Result<DaemonLease, StartupErrorType> {
	const leasePath = leasePathFor(projectDir);

	let db: Database | undefined;
	try {
		mkdirSync(dirname(leasePath), { recursive: true, mode: 0o700 });
		db = new Database(leasePath);
		db.run('PRAGMA busy_timeout = 0');
		db.run('BEGIN IMMEDIATE');
	} catch (cause) {
		try {
			db?.close();
		} catch {
			// Best-effort cleanup after failed acquisition.
		}
		if (isSqliteBusy(cause)) {
			return StartupError.AlreadyRunning({
				pid: readMetadata(projectDir)?.pid,
			});
		}
		return StartupError.LeaseFailed({ cause });
	}

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			if (db?.inTransaction) db.run('ROLLBACK');
		} catch {
			// Best-effort release; close still drops the OS lock.
		}
		try {
			db?.close();
		} catch {
			// Best-effort release.
		}
	};

	return Ok({
		projectDir,
		leasePath,
		socketPath: socketPathFor(projectDir),
		release,
	});
}

function isSqliteBusy(cause: unknown): boolean {
	return (
		cause instanceof Error &&
		(cause as Error & { code?: unknown }).code === 'SQLITE_BUSY'
	);
}
