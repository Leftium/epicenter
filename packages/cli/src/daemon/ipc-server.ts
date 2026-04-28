/**
 * Newline-delimited JSON IPC server bound to a Unix socket.
 *
 * The `epicenter up` daemon listens here so sibling CLI invocations targeting
 * the same `--dir` can reuse its warm workspace. Clients open the socket,
 * write one JSON request per line, and read zero-or-more JSON responses
 * (each tagged with the matching `id`); a response carrying `end: true`
 * terminates a streamed reply.
 *
 * Wire shape is a `Result<T, SerializedError>` envelope augmented with
 * frame-level metadata (`id`, optional `end`). `data: null + error: ...`
 * means the request failed; `data: T + error: null` is success. This
 * mirrors the codebase's wellcrafted convention so callers don't have to
 * learn a parallel `{ok, error}` shape.
 *
 * Wire format and security model are deliberately internal; see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol"
 * and § "Security model". The CLI is the only sanctioned client.
 */

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Socket } from 'bun';
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
 * handlers). `BadRequest` for un-parseable JSON lines; `HandlerCrashed` when
 * a handler promise rejects. Both are wire-serialized; the client sees
 * `{name, message, ...}` on the error side of the `Result` envelope.
 */
export const IpcServerError = defineErrors({
	BadRequest: ({ cause }: { cause: unknown }) => ({
		message: `invalid JSON: ${extractErrorMessage(cause)}`,
		cause,
	}),
	HandlerCrashed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type IpcServerError = InferErrors<typeof IpcServerError>;

/**
 * Structural shape of any tagged error on the wire — the JSON form of a
 * `defineErrors` variant after it crosses the socket.
 *
 * The type guarantees `name` and `message` only; variant-specific fields
 * (`socketPath` on `NoDaemon`, `timeoutMs` on `Timeout`, etc.) survive
 * `JSON.stringify` at runtime but require narrowing on a known variant
 * union (e.g. `IpcClientError | IpcServerError`) to access. This is
 * honest about the boundary: the wire receives errors from multiple
 * domains (transport, app handlers, arbitrary thrown exceptions in the
 * dispatcher), so the bare-frame type stays minimal and callers tighten
 * via the `Result<T, ...>` `E` parameter when they need variant access.
 */
export type SerializedError = {
	name: string;
	message: string;
};

/** Single JSON request frame from a client. */
export type IpcRequest = {
	id: string;
	cmd: string;
	args?: unknown;
};

/**
 * Single JSON response frame.
 *
 * Streamed handlers may emit multiple ok frames sharing the same `id`; the
 * final one carries `end: true`. Errors are terminal: one error frame
 * closes that request. The body is `Result<T, SerializedError>` with the
 * frame metadata (`id`, optional `end`) sitting alongside.
 */
export type IpcFrame<T = unknown, E extends SerializedError = SerializedError> = {
	id: string;
	end?: boolean;
} & Result<T, E>;

/**
 * Per-request handler. Implementations call `send` zero-or-more times to
 * emit response frames; for streamed replies, the last one should set
 * `end: true`. Build success frames as `{id, data, error: null}` and error
 * frames as `{id, data: null, error: TaggedError}`.
 *
 * The server intentionally does not enforce "at least one response": a
 * `cmd: shutdown` handler, for instance, may legitimately reply once and
 * then trigger teardown without further frames.
 */
export type IpcHandler = (
	req: IpcRequest,
	send: (frame: IpcFrame) => void,
) => void | Promise<void>;

/**
 * Public handle returned by {@link startIpcServer}. Narrowed to the surface
 * callers actually use (`.stop()` for graceful shutdown), so the per-socket
 * data generic and the rest of Bun's listener API stay implementation detail.
 */
export type IpcServerHandle = { stop(): void };

/** Per-connection state held in `socket.data` for line-buffered reads. */
type IpcSocketData = { buffer: string };

/**
 * Bind a Unix socket at `socketPath` and dispatch each newline-delimited
 * JSON request to `handler`.
 *
 * Filesystem hardening:
 * - Parent directory is created (recursive) with mode `0700`.
 * - Socket file is `chmod 0600` immediately after `listen`.
 * - Use {@link unlinkSocketFile} after `.stop()` to sweep the path.
 *
 * Returns the underlying Bun listener so the caller owns lifecycle (the
 * daemon needs `.stop()` for graceful shutdown).
 */
export async function startIpcServer(
	socketPath: string,
	handler: IpcHandler,
): Promise<IpcServerHandle> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	const server = Bun.listen<IpcSocketData>({
		unix: socketPath,
		socket: {
			open(socket) {
				socket.data = { buffer: '' };
				log.debug('ipc connection accepted', { socketPath });
			},
			data(socket, chunk) {
				// Bun hands us a Buffer; accumulate into the per-socket buffer
				// and split on newlines, keeping the trailing partial line.
				socket.data.buffer += chunk.toString('utf8');
				let nl = socket.data.buffer.indexOf('\n');
				while (nl !== -1) {
					const line = socket.data.buffer.slice(0, nl);
					socket.data.buffer = socket.data.buffer.slice(nl + 1);
					processLine(socket, line, handler);
					nl = socket.data.buffer.indexOf('\n');
				}
			},
			close() {
				// No-op: per-socket buffer goes with the socket.
			},
			error(_socket, _err) {
				// Client side aborts surface here; nothing useful to do but not
				// crash the daemon. Logging at debug keeps the noise floor low.
				log.debug('ipc socket error');
			},
		},
	});

	chmodSync(socketPath, 0o600);

	return server;
}

/**
 * Process one accumulated line. Dispatches to the handler, emitting
 * `IpcServerError.BadRequest` for un-parseable JSON and
 * `IpcServerError.HandlerCrashed` for rejected handler promises.
 */
function processLine(
	socket: Socket<IpcSocketData>,
	line: string,
	handler: IpcHandler,
): void {
	// Tolerate blank lines from clients that send trailing newlines.
	if (line.length === 0) return;

	const send = (frame: IpcFrame) => {
		socket.write(`${JSON.stringify(frame)}\n`);
	};

	let req: IpcRequest;
	try {
		req = JSON.parse(line) as IpcRequest;
	} catch (cause) {
		// Per-line failure; keep the connection open so other lines
		// (potentially from a pipelining client) can still be served.
		const tagged = IpcServerError.BadRequest({ cause });
		send({ id: '', data: null, error: tagged.error });
		return;
	}

	void Promise.resolve(handler(req, send)).catch((cause) => {
		const tagged = IpcServerError.HandlerCrashed({ cause });
		send({ id: req.id ?? '', data: null, error: tagged.error });
	});
}

/**
 * Best-effort socket-file cleanup. Bun's `.stop()` doesn't unlink the
 * `unix` socket file in every Bun version; this is the manual sweep we
 * still want for the orphan-detection paths (where the file may have
 * been left behind by a crashed previous daemon).
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
