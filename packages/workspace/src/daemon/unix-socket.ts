/**
 * Bind a request handler to a unix socket via `Bun.serve`. Filesystem
 * hardening lives here; route definitions live in `app.ts`.
 *
 * - Parent directory `mkdirSync` (recursive) with mode `0700`.
 * - Socket file `chmod 0600` immediately after `Bun.serve` returns.
 * - `Bun.serve.stop()` auto-unlinks the socket file on graceful shutdown.
 *   {@link unlinkSocketFile} is for orphan-sweep paths only.
 *
 * Wire format and security model are deliberately internal; see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol"
 * and § "Security model". The CLI is the only sanctioned client.
 */

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';

import { readMetadata, unlinkMetadata } from './metadata.js';

export type BindUnixSocketOptions = {
	socketPath: string;
	fetch: (
		request: Request,
		server: Bun.Server<undefined>,
	) => Response | Promise<Response>;
};
export type BindOrRecoverOptions = BindUnixSocketOptions & {
	projectDir: string;
	isSocketResponsive: (
		socketPath: string,
		timeoutMs?: number,
	) => Promise<boolean>;
};

/**
 * Tagged-error variants for daemon startup. `bindOrRecover` returns one of
 * these on failure; the `up` handler renders `error.message` to stderr and
 * exits 1.
 *
 * - `AlreadyRunning`: another daemon owns this project lease or answers ping.
 * - `LeaseFailed`: the SQLite lease could not be opened or locked.
 * - `BindFailed`: `Bun.serve` raised on an unrecoverable bind error
 *   (filesystem permission, missing parent dir we couldn't `mkdir`, etc.).
 *   Reserved for genuinely-unexpected failures; the recovery branch
 *   (orphan sweep + retry) handles the common stale-socket case.
 */
export const StartupError = defineErrors({
	AlreadyRunning: ({ pid }: { pid?: number }) => ({
		message: `daemon already running${pid !== undefined ? ` (pid=${pid})` : ''}`,
		pid,
	}),
	LeaseFailed: ({ cause }: { cause: unknown }) => ({
		message: `daemon lease failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	BindFailed: ({ cause }: { cause: unknown }) => ({
		message: `bind failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type StartupError = InferErrors<typeof StartupError>;

/**
 * Bind `fetch` to a unix socket at `socketPath`. Returns the Bun
 * listener so the daemon body owns lifecycle.
 */
export function bindUnixSocket({
	socketPath,
	fetch,
}: BindUnixSocketOptions): Bun.Server<undefined> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	const server = Bun.serve({
		unix: socketPath,
		fetch,
	});

	chmodSync(socketPath, 0o600);

	return server;
}

/**
 * Bind after the caller has already claimed the project daemon lease. A
 * responsive socket still wins to avoid clobbering a live daemon from an older
 * build that did not participate in the lease protocol.
 *
 *   1. Socket file absent: bind clean.
 *   2. Socket file present, ping answers: live daemon owns the dir;
 *      return `AlreadyRunning(pid)` from the metadata sidecar.
 *   3. Socket file present, ping silent: orphan from a crashed daemon.
 *      Sweep socket + metadata, then bind.
 *
 * `Bun.serve({ unix })` overwrites an existing socket file without
 * raising `EADDRINUSE`, so the "try-bind, recover on EADDRINUSE"
 * pattern from POSIX TCP doesn't apply here.
 *
 * `isSocketResponsive` is injected so this module doesn't depend on
 * `client.ts` (the import cycle would be ugly) and tests can stub the probe.
 */
export async function bindOrRecover({
	socketPath,
	projectDir,
	fetch,
	isSocketResponsive,
}: BindOrRecoverOptions): Promise<Result<Bun.Server<undefined>, StartupError>> {
	if (!existsSync(socketPath)) {
		return trySync({
			try: () => bindUnixSocket({ socketPath, fetch }),
			catch: (cause) => StartupError.BindFailed({ cause }),
		});
	}

	if (await isSocketResponsive(socketPath, 250)) {
		return StartupError.AlreadyRunning({
			pid: readMetadata(projectDir)?.pid,
		});
	}

	unlinkSocketFile(socketPath);
	unlinkMetadata(projectDir);
	return trySync({
		try: () => bindUnixSocket({ socketPath, fetch }),
		catch: (cause) => StartupError.BindFailed({ cause }),
	});
}

/**
 * Best-effort socket-file cleanup. `Bun.serve.stop()` already unlinks on
 * graceful shutdown; this is the manual sweep for orphan-detection paths
 * (the file may have been left behind by a crashed previous daemon).
 */
export function unlinkSocketFile(socketPath: string): void {
	void trySync({
		try: () => unlinkSync(socketPath),
		catch: () => Ok(undefined),
	});
}
