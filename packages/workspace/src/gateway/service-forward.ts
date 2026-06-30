/**
 * The consuming side of a service route: a localhost forward the daemon owns.
 *
 * On the CONSUMER device this opens a local TCP listener and, for each inbound
 * connection, dials the remote device's service route over the relay floor and
 * dumb-pipes the two together. So an ordinary client points a
 * `Connection { baseUrl: 'http://127.0.0.1:<port>' }` at the forward and reaches
 * the remote service UNCHANGED: `resolveConnection` -> `{ fetch, baseURL }` works
 * with no awareness of the relay, exactly as it would against a local server.
 * That is the whole point of the native slice: the HTTP is spoken by the
 * OS-level client and server at the two ends; the forward (and the relay) only
 * move bytes, never parse them.
 *
 * The heavier, separable slice is an in-browser HTTP-over-`ByteChannel` fetch
 * (no localhost listener available in a browser); it is earned later, when a
 * browser needs to reach a service route with no daemon to forward through.
 *
 * NODE-ONLY: it binds a TCP listener (`node:net`). Like the route target, the
 * daemon owns it; the browser-safe relay-channel transport does not.
 */

import { type AddressInfo, createServer, type Socket } from 'node:net';
import type { NodeId } from '../document/node-id.js';
import type { PeerTransport, RouteName } from '../peer-transport.js';
import {
	nodeReadableToWeb,
	nodeWritableToWeb,
} from './node-stream-bridge.js';

export type ServiceForwardOptions = {
	/** The transport-blind seam to the remote peer's gateway (the relay floor). */
	transport: PeerTransport;
	/** The device whose service route this forward reaches, by its {@link NodeId}. */
	target: NodeId;
	/** The named service route on the target gateway (e.g. `whisper`). */
	route: RouteName;
};

/**
 * A forward always binds `127.0.0.1` with an OS-assigned ephemeral port: it
 * bridges a REMOTE device's service to this machine, so binding anything but
 * loopback would expose that service to the local network with no auth, and the
 * consumer reads the assigned port back off {@link ServiceForward.port} to build
 * its `Connection.baseUrl`. A fixed port or a different bind is a non-breaking
 * option to add the day a consumer needs one; none does yet.
 */
const FORWARD_HOST = '127.0.0.1';
const FORWARD_PORT = 0;

export type ServiceForward = {
	/** The loopback port the forward listens on: the host of the consumer's `Connection.baseUrl`. */
	port: number;
	/**
	 * Stop accepting and destroy every live connection. Destroying a socket aborts
	 * its pipes, which reset its relay channel; this resolves once the listener is
	 * shut and the sockets are destroyed, not after each reset has flushed (the
	 * shared transport's own `close` reclaims any straggler entry regardless).
	 */
	close(): Promise<void>;
};

/**
 * Open a localhost forward to a remote service route and return its port. Async
 * because binding the listener is async; the per-connection relay dials happen
 * lazily as clients connect.
 */
export function createServiceForward(
	options: ServiceForwardOptions,
): Promise<ServiceForward> {
	const { transport, target, route } = options;

	// Track live sockets so `close()` can drop in-flight connections; a connection
	// removes itself on close, so this never grows past the live set.
	const sockets = new Set<Socket>();

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		void bridgeConnection(socket);
	});

	/**
	 * One inbound localhost connection becomes one relay channel to the remote
	 * service, dumb-piped both directions. A failed dial (refused, offline, or a
	 * hung handshake) destroys the socket so the client sees a closed connection,
	 * not a hang; either pipe settling tears the other half down so neither
	 * lingers.
	 */
	async function bridgeConnection(socket: Socket): Promise<void> {
		let channel: Awaited<ReturnType<PeerTransport['openChannel']>>;
		try {
			channel = await transport.openChannel({ target, route });
		} catch {
			socket.destroy();
			return;
		}
		void nodeReadableToWeb(socket)
			.pipeTo(channel.sink)
			.catch(() => socket.destroy());
		void channel.source
			.pipeTo(nodeWritableToWeb(socket))
			.catch(() => socket.destroy());
	}

	return new Promise((resolve) => {
		server.listen(FORWARD_PORT, FORWARD_HOST, () => {
			resolve({
				port: (server.address() as AddressInfo).port,
				close: () =>
					new Promise<void>((res) => {
						for (const socket of sockets) socket.destroy();
						sockets.clear();
						server.close(() => res());
					}),
			});
		});
	});
}
