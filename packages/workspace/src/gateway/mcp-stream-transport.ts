/**
 * MCP JSON-RPC over a {@link ByteChannel}: the transport that lets an MCP
 * `Client`/`Server` ride any of the byte channels the gateway speaks.
 *
 * A {@link ByteChannel} is `{ source, sink }`. iroh's `connection.openBi()` hands
 * you exactly that (a recv source, a send sink), stdio is the same shape (stdin =
 * source, stdout = sink), and an in-memory pipe is too. So an MCP transport
 * written against the channel works over an iroh bi-stream (the cross-device tool
 * path), over a child's stdio, and over an in-memory pipe in a test, with no
 * change to the `Client`/`Server` above it.
 *
 * NODE-ONLY: the channel halves are node streams, and the SDK's framing helpers
 * pull in `node:*`. It lives under the gateway subpath, reached only through the
 * node-side cross-device tool layer, never a browser build.
 *
 * Lifted from the proven `proto/super-chat-gateway-iroh` prototype (commit
 * 9d538b18cb), retyped against {@link ByteChannel} and rebuilt as a factory: the
 * private framing state (`readBuffer`, the started/closed flags) lives in the
 * closure, and the methods read the live `onmessage`/`onclose`/`onerror` the SDK
 * assigns onto the returned object.
 */

import {
	ReadBuffer,
	serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ByteChannel } from '../peer-transport.js';

/**
 * An MCP {@link Transport} over a {@link ByteChannel}. Mirrors the SDK's
 * `StdioServerTransport` framing (newline-delimited JSON-RPC), but reads its
 * bytes from `channel.source` and writes them to `channel.sink` rather than
 * `process.stdin`/`process.stdout`.
 *
 * The SDK's `Protocol` assigns `onmessage`/`onclose`/`onerror` onto the transport
 * AFTER construction, so the methods read those fields off the returned object
 * (not a captured local), and the disposer fires `onclose` exactly once.
 */
export function createStreamTransport(channel: ByteChannel): Transport {
	const readBuffer = new ReadBuffer();
	let started = false;
	let closed = false;

	// `onclose` must fire exactly once whether the remote half closes (the
	// source's 'close' event) or we close locally; both paths route here.
	const fireClose = () => {
		if (closed) return;
		closed = true;
		transport.onclose?.();
	};

	const transport: Transport = {
		onmessage: undefined,
		onclose: undefined,
		onerror: undefined,

		async start(): Promise<void> {
			if (started) throw new Error('StreamTransport already started');
			started = true;
			channel.source.on('data', (chunk: Buffer) => {
				readBuffer.append(chunk);
				for (;;) {
					let message: JSONRPCMessage | null;
					try {
						message = readBuffer.readMessage();
					} catch (error) {
						transport.onerror?.(error as Error);
						return;
					}
					if (message === null) break;
					transport.onmessage?.(message);
				}
			});
			channel.source.on('error', (error) => transport.onerror?.(error));
			// The sink is a Writable too: a failed `writeAll`/`finish` on the iroh
			// send half surfaces as an 'error' event. `send` writes without a
			// per-write error callback path that suppresses it, so without this
			// listener that event is unhandled and crashes the process; route it
			// through the same `onerror` hook as the source.
			channel.sink.on('error', (error) => transport.onerror?.(error));
			channel.source.on('close', fireClose);
		},

		async send(message: JSONRPCMessage): Promise<void> {
			// Await the write so a failed send rejects (the MCP `Client` fails the
			// pending request fast) instead of resolving as if it had been sent, and
			// so a full sink applies backpressure rather than buffering unboundedly.
			await new Promise<void>((resolve, reject) => {
				channel.sink.write(serializeMessage(message), (error) =>
					error ? reject(error) : resolve(),
				);
			});
		},

		async close(): Promise<void> {
			// End the send half and release the recv half so the channel is not left
			// half-open; fire `onclose` once. The underlying iroh connection is closed
			// by the dialer that owns it (see `gateway.dial`).
			channel.sink.end();
			channel.source.destroy();
			fireClose();
		},
	};

	return transport;
}
