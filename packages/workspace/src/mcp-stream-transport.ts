/**
 * MCP JSON-RPC over a {@link ByteChannel}: the transport that lets an MCP
 * `Client`/`Server` ride any byte channel the seam produces.
 *
 * A {@link ByteChannel} is `{ source: ReadableStream, sink: WritableStream }`
 * (Web Streams), so this transport is runtime-portable: it rides a child's stdio
 * (a route target, adapted with `Readable.toWeb`/`Writable.toWeb`) and the
 * relay-channel's account-room frames (the browser floor) with no change to the
 * `Client`/`Server` above it.
 *
 * Browser-safe by construction: it uses only Web Streams, `TextEncoder` /
 * `TextDecoder`, and the MCP SDK's `JSONRPCMessageSchema` (zod). It never
 * touches a node stream or the node `Buffer`-backed `ReadBuffer`; the framing is
 * the same newline-delimited JSON-RPC the SDK's stdio transport speaks
 * (`serializeMessage` is `JSON.stringify(message) + "\n"`), reimplemented
 * portably here.
 *
 * The SDK's `Protocol` assigns `onmessage`/`onclose`/`onerror` onto the
 * transport AFTER construction, so the methods read those fields off the
 * returned object, and the close path fires `onclose` exactly once.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	type JSONRPCMessage,
	JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ByteChannel } from './peer-transport.js';
import { once } from './shared/once.js';

/** An MCP {@link Transport} over a {@link ByteChannel} (Web Streams). */
export function createStreamTransport(channel: ByteChannel): Transport {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let started = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
	// Decoded text read off the source but not yet split into a full line.
	let pending = '';

	// `onclose` must fire exactly once whether the remote half ends (the pump
	// loop sees `done`), the source errors, or we close locally; all route here.
	const fireClose = once(() => transport.onclose?.());

	// Drain every complete newline-delimited JSON-RPC message out of `pending`.
	const drainLines = () => {
		for (;;) {
			const newline = pending.indexOf('\n');
			if (newline === -1) break;
			const line = pending.slice(0, newline).replace(/\r$/, '');
			pending = pending.slice(newline + 1);
			if (line.length === 0) continue;
			let message: JSONRPCMessage;
			try {
				message = JSONRPCMessageSchema.parse(JSON.parse(line));
			} catch (error) {
				transport.onerror?.(error as Error);
				continue;
			}
			transport.onmessage?.(message);
		}
	};

	const transport: Transport = {
		onmessage: undefined,
		onclose: undefined,
		onerror: undefined,

		async start(): Promise<void> {
			if (started) throw new Error('StreamTransport already started');
			started = true;
			reader = channel.source.getReader();
			writer = channel.sink.getWriter();
			// Pump the source until EOF/cancel; framing happens in `drainLines`.
			void (async () => {
				try {
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						if (value && value.length > 0) {
							pending += decoder.decode(value, { stream: true });
							drainLines();
						}
					}
				} catch (error) {
					transport.onerror?.(error as Error);
				} finally {
					fireClose();
				}
			})();
		},

		async send(message: JSONRPCMessage): Promise<void> {
			if (!writer) throw new Error('StreamTransport not started');
			// Await the write so a failed send rejects (the MCP `Client` fails the
			// pending request fast) instead of resolving as if sent, and a full sink
			// applies backpressure rather than buffering unboundedly.
			await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
		},

		async close(): Promise<void> {
			// End the send half and release the recv half so the channel is not left
			// half-open; fire `onclose` once. The underlying connection (the relay
			// channel, or a spawned child's stdio) is torn down by whoever owns it.
			try {
				await writer?.close();
			} catch {
				// sink already closed / errored
			}
			try {
				await reader?.cancel();
			} catch {
				// source already closed / errored
			}
			fireClose();
		},
	};

	return transport;
}
