/**
 * Bind a Hono app to a unix socket via `Bun.serve`. Filesystem hardening
 * lives here; route definitions live in `app.ts`.
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

import type { Hono } from 'hono';

/**
 * Structural shape of any tagged error on the wire. The type guarantees
 * `name` and `message` only; variant-specific fields survive
 * `JSON.stringify` at runtime but require narrowing on a known variant
 * union (e.g. `IpcClientError | RunError`) to access. Callers tighten via
 * the `Result<T, ...>` `E` parameter when they need variant access.
 */
export type SerializedError = {
	name: string;
	message: string;
};

/** Public handle returned by {@link startIpcServer}. */
export type IpcServerHandle = { stop(): void };

/**
 * Bind `app.fetch` to a unix socket at `socketPath`. Returns the Bun
 * listener narrowed to `.stop()` so the daemon body owns lifecycle.
 */
export async function startIpcServer(
	socketPath: string,
	app: Hono,
): Promise<IpcServerHandle> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	const server = Bun.serve({
		unix: socketPath,
		fetch: app.fetch,
	});

	chmodSync(socketPath, 0o600);

	return server;
}

/**
 * Best-effort socket-file cleanup. `Bun.serve.stop()` already unlinks on
 * graceful shutdown; this is the manual sweep for orphan-detection paths
 * (the file may have been left behind by a crashed previous daemon).
 */
export function unlinkSocketFile(socketPath: string): void {
	if (existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
		} catch {
			// Best-effort cleanup; another process may have raced us.
		}
	}
}
