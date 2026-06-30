/**
 * The device side of the relay floor: accept inbound channels and dumb-pipe them
 * to a named local route.
 *
 * It runs the device's accept loop over the relay-channel port. On a
 * `channel_open` it opens the named route's byte target (a warm MCP stdio child,
 * injected so this module stays browser-safe and never imports
 * `node:child_process`), answers `channel_accept`, and pipes the channel's bytes
 * to and from that target. It never parses the MCP frames; it is a dumb byte pipe.
 *
 * Browser-safe: the route opener is injected (the daemon wires it to
 * `gateway/route-table.openRouteTarget`), so this module pulls no node builtin.
 */

import type { RouteTarget } from '../peer-transport.js';
import { type ChannelBridge, createChannelBridge } from './channel-bytes.js';
import type { ChannelSource } from './protocol.js';
import type { ChannelPort } from './transport.js';

/**
 * Open the local byte target for an inbound channel, or `null` to refuse it (the
 * route table's default-closed gate). All
 * authorization lives HERE, in the injected opener, not in the acceptor: the
 * daemon refuses unless `source` is its own authenticated owner and the route is
 * explicitly relay-exposed, then returns `openRouteTarget(...)`. `source` is the
 * relay-authored identity (absent only if no compliant relay stamped it, which a
 * strict opener also refuses).
 */
export type RouteOpener = (request: {
	route: string;
	source?: ChannelSource;
}) => RouteTarget | null;

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
			const { id, route, source } = frame;
			if (live.has(id)) return; // duplicate id; ignore

			const target = openRoute({ route, source });
			if (!target) {
				port.send({
					type: 'channel_reset',
					id,
					code: 'refused',
					reason: `route ${route} refused`,
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
			// -> caller. Either pipe settling (a clean route EOF or an error) tears the
			// channel down once; the bridge's own close emits the terminal reset.
			void bridge.channel.source
				.pipeTo(target.channel.sink)
				.then(() => teardown(id), () => teardown(id));
			void target.channel.source
				.pipeTo(bridge.channel.sink)
				.then(() => teardown(id), () => teardown(id));
			return;
		}

		const entry = live.get(frame.id);
		if (!entry) return; // not an admitted channel; drop
		if (frame.type === 'channel_data' || frame.type === 'channel_reset') {
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
