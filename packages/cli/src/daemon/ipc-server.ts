/**
 * Newline-delimited JSON IPC server bound to a Unix socket.
 *
 * The daemon (`epicenter up`, Wave 5) listens here so sibling CLI invocations
 * targeting the same `--dir` can reuse its warm workspace. Clients open the
 * socket, write one JSON request per line, and read zero-or-more JSON
 * responses (each tagged with the matching `id`); a response carrying
 * `end: true` terminates a streamed reply.
 *
 * Wire format and security model are deliberately internal — see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol"
 * and § "Security model". The CLI is the only sanctioned client.
 */

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { createLogger } from 'wellcrafted/logger';

const log = createLogger('cli/daemon/ipc-server');

/** Single JSON request frame from a client. */
export type IpcRequest = {
	id: string;
	cmd: string;
	args?: unknown;
};

/**
 * Single JSON response frame.
 *
 * Streaming handlers may emit multiple `ok: true` frames sharing the same
 * `id`; the final frame carries `end: true`. Errors are terminal — one error
 * frame closes that request. The `{name, message}` shape is the serialized
 * form of any thrown/returned `wellcrafted/error` typed error.
 */
export type IpcResponse =
	| { id: string; ok: true; data?: unknown; end?: boolean }
	| { id: string; ok: false; error: { name: string; message: string } };

/**
 * Per-request handler. Implementations call `send` zero-or-more times to
 * emit responses; for streamed replies, the last one should set `end: true`.
 *
 * The server intentionally does not enforce "at least one response" — a
 * `cmd: shutdown` handler, for instance, may legitimately reply once and
 * then trigger teardown without further frames.
 */
export type IpcHandler = (
	req: IpcRequest,
	send: (r: IpcResponse) => void,
) => void | Promise<void>;

/**
 * Bind a Unix socket at `socketPath` and dispatch each newline-delimited
 * JSON request to `handler`.
 *
 * Filesystem hardening:
 * - Parent directory is created (recursive) with mode `0700`.
 * - Socket file is `chmod 0600` immediately after `listen`.
 * - On `server.close()`, the socket file is unlinked if it still exists.
 *
 * Returns the underlying `net.Server` so the caller owns lifecycle (the
 * daemon needs `close()` for graceful shutdown).
 */
export async function startIpcServer(
	socketPath: string,
	handler: IpcHandler,
): Promise<Server> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	const server = createServer((socket) => {
		log.debug('ipc connection accepted', { socketPath });

		const send = (response: IpcResponse) => {
			if (socket.writable) {
				socket.write(`${JSON.stringify(response)}\n`);
			}
		};

		const rl = createInterface({ input: socket });
		rl.on('line', (line) => {
			// Tolerate blank lines from clients that send trailing newlines.
			if (line.length === 0) return;

			let req: IpcRequest;
			try {
				req = JSON.parse(line) as IpcRequest;
			} catch (cause) {
				// Per-line failure — keep the connection open so other lines
				// (potentially from a pipelining client) can still be served.
				send({
					id: '',
					ok: false,
					error: {
						name: 'BadRequest',
						message: `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
					},
				});
				return;
			}

			void Promise.resolve(handler(req, send)).catch((cause) => {
				send({
					id: req.id ?? '',
					ok: false,
					error: {
						name: 'HandlerCrashed',
						message: cause instanceof Error ? cause.message : String(cause),
					},
				});
			});
		});

		socket.on('error', () => {
			// Client side aborts surface here; nothing useful to do but not
			// crash the daemon. Logging at debug keeps the noise floor low.
			log.debug('ipc socket error');
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			server.removeListener('listening', onListening);
			reject(err);
		};
		const onListening = () => {
			server.removeListener('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(socketPath);
	});

	chmodSync(socketPath, 0o600);

	// Honor lifecycle: when the caller closes the server, sweep the socket
	// file so a follow-up `up` doesn't see a phantom and bail.
	server.on('close', () => {
		if (existsSync(socketPath)) {
			try {
				unlinkSync(socketPath);
			} catch {
				// Best-effort cleanup; another process may have raced us.
			}
		}
	});

	return server;
}
