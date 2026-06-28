/**
 * Adapts iroh 1.0 stream halves to the {@link ByteChannel} shape used by the
 * transport seam.
 *
 * EOF contract for `RecvStream.read()`: the NAPI binding returns an empty array
 * at end-of-stream and may also throw on a reset. Both are treated as EOF.
 *
 * Lifted from the proven `proto/super-chat-gateway-iroh` prototype.
 */

import { PassThrough, Writable } from 'node:stream';
import type { BiStream, RecvStream, SendStream } from '@number0/iroh';
import type { ByteChannel } from './transport.js';

/**
 * Pump an iroh `RecvStream` into a Node `PassThrough` (the readable side). The
 * pump loop starts immediately and is not awaited by the caller.
 */
function recvToReadable(recv: RecvStream): PassThrough {
	const pt = new PassThrough();
	void (async () => {
		try {
			for (;;) {
				const bytes = await recv.read(65536);
				if (!bytes || bytes.length === 0) {
					// EOF: iroh signals end-of-stream with an empty array.
					pt.push(null);
					return;
				}
				pt.push(Buffer.from(bytes));
			}
		} catch {
			// Reset or connection close: also treated as EOF.
			pt.push(null);
		}
	})();
	return pt;
}

/**
 * Wrap an iroh `SendStream` as a Node `Writable`. Each write forwards the chunk
 * bytes; `final()` calls `send.finish()` to signal end-of-stream to the peer.
 */
function sendToWritable(send: SendStream): Writable {
	return new Writable({
		write(chunk: unknown, _enc: unknown, cb: (err?: Error | null) => void) {
			// chunk is a Buffer when decodeStrings is true (the default).
			send
				.writeAll([...Buffer.from(chunk as Buffer)])
				.then(() => cb())
				.catch(cb);
		},
		final(cb: (err?: Error | null) => void) {
			send
				.finish()
				.then(() => cb())
				.catch(cb);
		},
	});
}

/**
 * Adapt an iroh `BiStream` to the {@link ByteChannel} shape:
 *   - `source` = `bi.recv` (remote to us)
 *   - `sink`   = `bi.send` (us to remote)
 */
export function biStreamToByteChannel(bi: BiStream): ByteChannel {
	return {
		source: recvToReadable(bi.recv),
		sink: sendToWritable(bi.send),
	};
}
