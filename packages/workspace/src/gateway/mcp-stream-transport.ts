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
 * 9d538b18cb), retyped against {@link ByteChannel}.
 */

import {
	ReadBuffer,
	serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ByteChannel } from './transport.js';

/**
 * An MCP {@link Transport} over a {@link ByteChannel}. Mirrors the SDK's
 * `StdioServerTransport` framing (newline-delimited JSON-RPC), but reads its
 * bytes from `channel.source` and writes them to `channel.sink` rather than
 * `process.stdin`/`process.stdout`.
 */
export class StreamTransport implements Transport {
	private readBuffer = new ReadBuffer();
	private started = false;
	onmessage?: (message: JSONRPCMessage) => void;
	onclose?: () => void;
	onerror?: (error: Error) => void;

	constructor(private channel: ByteChannel) {}

	async start(): Promise<void> {
		if (this.started) throw new Error('StreamTransport already started');
		this.started = true;
		this.channel.source.on('data', (chunk: Buffer) => {
			this.readBuffer.append(chunk);
			for (;;) {
				let message: JSONRPCMessage | null;
				try {
					message = this.readBuffer.readMessage();
				} catch (error) {
					this.onerror?.(error as Error);
					return;
				}
				if (message === null) break;
				this.onmessage?.(message);
			}
		});
		this.channel.source.on('error', (error) => this.onerror?.(error));
		this.channel.source.on('close', () => this.onclose?.());
	}

	async send(message: JSONRPCMessage): Promise<void> {
		this.channel.sink.write(serializeMessage(message));
	}

	async close(): Promise<void> {
		this.channel.sink.end();
		this.onclose?.();
	}
}
