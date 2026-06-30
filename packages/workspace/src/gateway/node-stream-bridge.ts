/**
 * The one home for the node-stream to Web-Streams bridge.
 *
 * `Readable.toWeb` / `Writable.toWeb` do the real conversion (with backpressure),
 * but `@types/node` types them against node's `stream/web` `ReadableStream`, a TS
 * type distinct from the global Web Streams the {@link ByteChannel} seam is typed
 * against even though Bun makes them one runtime object. That nominal gap is the
 * only reason a cast exists; naming it here keeps the seam's call sites clean and
 * gives the interop a single documented place to live.
 *
 * The route TARGET ({@link ./route-table.openRouteTarget}) uses it to adapt a
 * spawn child's stdio to the {@link ../peer-transport.ByteChannel} the relay
 * channel rides. NODE-ONLY.
 */

import { Readable, Writable } from 'node:stream';

/** Adapt a node {@link Readable} to a global Web {@link ReadableStream}. */
export function nodeReadableToWeb(
	readable: Readable,
): ReadableStream<Uint8Array> {
	return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>;
}

/** Adapt a node {@link Writable} to a global Web {@link WritableStream}. */
export function nodeWritableToWeb(
	writable: Writable,
): WritableStream<Uint8Array> {
	return Writable.toWeb(writable) as unknown as WritableStream<Uint8Array>;
}
