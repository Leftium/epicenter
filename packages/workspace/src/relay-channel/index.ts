/**
 * `@epicenter/workspace/relay-channel`: the relay floor.
 *
 * The browser-safe half of the universal device-channel relay: typed
 * request/response channels multiplexed over the account-room WebSocket each
 * device already holds, behind the {@link PeerTransport} seam. Pure TypeBox
 * protocol plus a browser-safe transport; it pulls no node builtin and no
 * transport-native dependency, so it is the floor a browser uses with no app.
 *
 * The server-side routing of these frames lives in
 * `packages/server/src/room/channel-router.ts`; the two share only the wire
 * {@link ./protocol} module.
 */

// The seam every channel rides, re-exported here so a browser names a route and
// holds a transport from the floor barrel alone.
export {
	asRouteName,
	type ByteChannel,
	type OpenChannelOptions,
	type PeerTransport,
	type RouteName,
} from '../peer-transport.js';
export * from './acceptor.js';
export * from './channel-bytes.js';
export * from './channel-port.js';
export * from './protocol.js';
export * from './transport.js';
