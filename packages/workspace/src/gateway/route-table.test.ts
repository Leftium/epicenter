/**
 * The `service` route arm: `openRouteTarget` opens a TCP connection to a local
 * service and hands back the same {@link ByteChannel} seam a spawn route does, so
 * the relay acceptor dumb-pipes it without learning the kind. This proves the
 * second vocabulary's local target (HTTP-shaped bytes to a service port) rides
 * the identical seam as the MCP spawn target.
 */

import { expect, test } from 'bun:test';
import { type AddressInfo, createServer } from 'node:net';
import { openRouteTarget } from './route-table.js';

/** A localhost TCP echo server standing in for a local service (e.g. a whisper box). */
async function echoServer(): Promise<{ port: number; close: () => void }> {
	const server = createServer((socket) => {
		socket.on('data', (chunk) => socket.write(chunk));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as AddressInfo).port,
		close: () => server.close(),
	};
}

test('a service route dumb-pipes the channel to a local TCP socket', async () => {
	const service = await echoServer();
	const target = openRouteTarget({
		kind: 'service',
		service: { port: service.port },
		relay: 'exposed',
	});

	// Bytes written to the channel sink reach the service and echo back on the
	// channel source: the bidirectional dumb pipe the acceptor relies on.
	const writer = target.channel.sink.getWriter();
	const reader = target.channel.source.getReader();
	await writer.write(new TextEncoder().encode('ping'));

	const { value } = await reader.read();
	expect(value && new TextDecoder().decode(value)).toBe('ping');

	reader.releaseLock();
	await writer.close().catch(() => {});
	target.close();
	service.close();
});

test('a service route to a refused port fails gracefully, never crashing the daemon', async () => {
	// Bind then immediately close a server to get a port guaranteed to refuse.
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const deadPort = (probe.address() as AddressInfo).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));

	// The connect's ECONNREFUSED must surface as a stream rejection (the acceptor
	// pipe then resets the channel), NOT an unhandled socket 'error' that takes the
	// long-lived daemon process down. The toWeb bridge attaches its error listener
	// synchronously at construction, before the async connect failure fires.
	const target = openRouteTarget({
		kind: 'service',
		service: { port: deadPort },
		relay: 'exposed',
	});
	const reader = target.channel.source.getReader();
	let rejected = false;
	await reader.read().catch(() => {
		rejected = true;
	});
	expect(rejected).toBe(true);

	reader.releaseLock();
	target.close();
});
