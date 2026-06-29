/**
 * The device side of the relay floor: accept inbound channels and dumb-pipe them
 * to a named local route.
 *
 * It is the mirror of the iroh gateway's accept loop, over the relay-channel port
 * instead of an iroh endpoint. On a `channel_open` it opens the named route's
 * byte target (a warm MCP stdio child, injected so this module stays browser-safe
 * and never imports `node:child_process`), answers `channel_accept`, and pipes
 * the channel's bytes to and from that target. It never parses the MCP frames; it
 * is the same dumb byte pipe as the native path.
 *
 * Browser-safe: the route opener is injected (the daemon wires it to
 * `gateway/route-table.openRouteTarget`), so this module pulls no node builtin.
 */

import type { ByteChannel } from '../peer-transport.js';
import { type ChannelBridge, createChannelBridge } from './channel-bytes.js';
import type { ChannelPort } from './transport.js';

/** A live local route target: its byte channel plus a teardown handle. */
export type RouteTarget = { channel: ByteChannel; close(): void };

/**
 * Open the local byte target for a named route, or `null` if the route is not
 * exposed (the relay-channel equivalent of the iroh route table's default-closed
 * gate). The daemon injects `(route) => routes[route] ? openRouteTarget(...) : null`.
 */
export type RouteOpener = (route: string) => RouteTarget | null;

export type ChannelAcceptor = {
	/** Detach from the port and tear down every live route target. */
	close(): void;
};

/** One admitted channel: its byte bridge and the route target it pipes to. */
type LiveChannel = { bridge: ChannelBridge; target: RouteTarget };

/**
 * Accept inbound relay channels on `port` and pipe each to a named route opened
 * by `openRoute`.
 */
export function createChannelAcceptor(
	port: ChannelPort,
	openRoute: RouteOpener,
): ChannelAcceptor {
	const live = new Map<string, LiveChannel>();

	function teardown(id: string): void {
		const entry = live.get(id);
		if (!entry) return;
		live.delete(id);
		entry.target.close();
	}

	const unsubscribe = port.onFrame((frame) => {
		if (frame.type === 'channel_open') {
			const { id, route } = frame;
			if (live.has(id)) return; // duplicate id; ignore

			const target = openRoute(route);
			if (!target) {
				port.send({
					type: 'channel_reset',
					id,
					code: 'refused',
					reason: `unknown route ${route}`,
				});
				return;
			}

			port.send({ type: 'channel_accept', id });
			const bridge = createChannelBridge({
				id,
				send: (outbound) => port.send(outbound),
				onTeardown: () => teardown(id),
			});
			live.set(id, { bridge, target });

			// Dumb byte pipe both directions: caller bytes -> route stdin, route stdout
			// -> caller. A pipe failure is swallowed; teardown closes the target child.
			void bridge.channel.source.pipeTo(target.channel.sink).catch(() => {});
			void target.channel.source.pipeTo(bridge.channel.sink).catch(() => {});
			return;
		}

		const entry = live.get(frame.id);
		if (!entry) return; // not an admitted channel; drop
		if (
			frame.type === 'channel_data' ||
			frame.type === 'channel_end' ||
			frame.type === 'channel_reset'
		) {
			entry.bridge.handleInbound(frame);
		}
	});

	return {
		close() {
			unsubscribe();
			for (const id of [...live.keys()]) teardown(id);
		},
	};
}
