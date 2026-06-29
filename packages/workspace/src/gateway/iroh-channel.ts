/**
 * Adapts iroh 1.0 stream halves to the {@link ByteChannel} shape used by the
 * transport seam (Web Streams, so the same channel an iroh bi-stream feeds also
 * drives the browser-safe MCP transport).
 *
 * EOF contract for `RecvStream.read()`: the NAPI binding returns an empty array
 * at end-of-stream and may also throw on a reset. Both are treated as EOF.
 *
 * Lifted from the proven `proto/super-chat-gateway-iroh` prototype, retargeted
 * from node streams onto Web Streams.
 */

import type { BiStream, RecvStream, SendStream } from '@number0/iroh';
import type { ByteChannel } from '../peer-transport.js';
import { once } from '../shared/once.js';

/**
 * Pump an iroh `RecvStream` into a Web `ReadableStream`. One `recv.read()` per
 * `pull`, so backpressure is the consumer's: the next read is not issued until
 * the consumer asks for more. `onEnd` fires once when the stream ends (EOF,
 * reset, or consumer cancel), the signal the dialer uses to release its iroh
 * connection.
 */
function recvToReadable(
	recv: RecvStream,
	onEnd: () => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const bytes = await recv.read(65536);
				if (!bytes || bytes.length === 0) {
					// EOF: iroh signals end-of-stream with an empty array.
					controller.close();
					onEnd();
					return;
				}
				controller.enqueue(new Uint8Array(bytes));
			} catch {
				// Reset or connection close: also treated as EOF.
				controller.close();
				onEnd();
			}
		},
		cancel() {
			onEnd();
		},
	});
}

/**
 * Wrap an iroh `SendStream` as a Web `WritableStream`. Each write forwards the
 * chunk bytes; `close`/`abort` call `send.finish()` to signal end-of-stream to
 * the peer. `onEnd` fires once when the writable closes or aborts.
 */
function sendToWritable(
	send: SendStream,
	onEnd: () => void,
): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		async write(chunk) {
			await send.writeAll([...chunk]);
		},
		async close() {
			try {
				await send.finish();
			} finally {
				onEnd();
			}
		},
		async abort() {
			try {
				await send.finish();
			} catch {
				// already reset / gone
			} finally {
				onEnd();
			}
		},
	});
}

/**
 * Adapt an iroh `BiStream` to the {@link ByteChannel} shape:
 *   - `source` = `bi.recv` (remote to us)
 *   - `sink`   = `bi.send` (us to remote)
 *
 * `onClose` fires once when EITHER half ends (the recv hits EOF or is canceled,
 * or the send is closed/aborted). The dial side passes its connection release
 * here so a torn-down channel never leaks the underlying iroh connection; the
 * accept side omits it and tears down through its pipe completions instead.
 */
export function biStreamToByteChannel(
	bi: BiStream,
	onClose?: () => void,
): ByteChannel {
	const fire = once(() => onClose?.());
	return {
		source: recvToReadable(bi.recv, fire),
		sink: sendToWritable(bi.send, fire),
	};
}
