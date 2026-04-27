/**
 * HTTP-over-unix-socket IPC server for the `epicenter up` daemon.
 *
 * Sibling CLI invocations targeting the same `--dir` reuse the daemon's warm
 * workspace by issuing JSON POSTs to a per-workspace unix socket. The body of
 * a 200 response is a `Result<T, SerializedError>` produced by the registered
 * route handler; transport-level failures (fetch reject, non-200) are
 * synthesized into `IpcClientError` variants on the client side.
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
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';

const log = createLogger('cli/daemon/ipc-server');

/**
 * Tagged-error variants emitted by the IPC transport itself (not by command
 * handlers). `HandlerCrashed` covers any thrown exception in a route handler.
 * Wire-serialized as `{name, message, ...}` on the error side of `Result`.
 */
export const IpcServerError = defineErrors({
	HandlerCrashed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type IpcServerError = InferErrors<typeof IpcServerError>;

/**
 * Structural shape of any tagged error on the wire. The type guarantees
 * `name` and `message` only; variant-specific fields survive
 * `JSON.stringify` at runtime but require narrowing on a known variant
 * union (e.g. `IpcClientError | IpcServerError`) to access. Callers tighten
 * via the `Result<T, ...>` `E` parameter when they need variant access.
 */
export type SerializedError = {
	name: string;
	message: string;
};

/**
 * One route handler. Receives the JSON-parsed `args` from the request body
 * (or `null` if the caller passed `undefined`) and returns a `Result` whose
 * shape is the response body. Throwing is allowed; the server traps it as
 * `IpcServerError.HandlerCrashed` and replies with HTTP 500.
 */
export type IpcRouteHandler = (
	args: unknown,
) => Promise<Result<unknown, SerializedError>>;

/**
 * Routes table passed to {@link startIpcServer}. Keys are command names
 * (e.g. `ping`, `list`); each becomes a `POST /<cmd>` endpoint on the unix
 * socket. The client sends `cmd` to `ipcCall(sock, cmd, args)` and the
 * server dispatches by string match.
 */
export type IpcRoutes = Record<string, IpcRouteHandler>;

/**
 * Public handle returned by {@link startIpcServer}. Narrowed to `.stop()`
 * so Bun's full Server surface stays implementation detail.
 */
export type IpcServerHandle = { stop(): void };

/**
 * Bind a unix-socket HTTP server at `socketPath` and route POSTs to the
 * matching entry in `routes`.
 *
 * Filesystem hardening:
 * - Parent directory is created (recursive) with mode `0700`.
 * - Socket file is `chmod 0600` immediately after `Bun.serve` returns.
 * - `Bun.serve.stop()` auto-unlinks the socket file; use
 *   {@link unlinkSocketFile} only for orphan-sweep paths where a crashed
 *   previous daemon left the file behind.
 */
export async function startIpcServer(
	socketPath: string,
	routes: IpcRoutes,
): Promise<IpcServerHandle> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	const routeEntries: Record<string, (req: Request) => Promise<Response>> = {};
	for (const [cmd, handler] of Object.entries(routes)) {
		routeEntries[`/${cmd}`] = makeRouteAdapter(cmd, handler);
	}

	const server = Bun.serve({
		unix: socketPath,
		routes: routeEntries,
		fetch() {
			return new Response('not found', { status: 404 });
		},
		error(err) {
			log.debug('ipc handler crash', { err });
			const tagged = IpcServerError.HandlerCrashed({ cause: err });
			return Response.json(tagged.error, { status: 500 });
		},
	});

	chmodSync(socketPath, 0o600);

	return server;
}

/**
 * Wrap one route handler in the request/response adapter. Parses the JSON
 * body (treating an empty body as `null`), invokes the handler, and
 * serializes the resulting `Result` as the response body. A handler that
 * throws bubbles to `Bun.serve`'s `error()` callback above and surfaces as
 * `IpcServerError.HandlerCrashed`.
 */
function makeRouteAdapter(
	cmd: string,
	handler: IpcRouteHandler,
): (req: Request) => Promise<Response> {
	return async (req) => {
		log.debug('ipc cmd', { cmd });
		const text = await req.text();
		const args = text.length === 0 ? null : (JSON.parse(text) as unknown);
		const result = await handler(args);
		return Response.json(result);
	};
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
