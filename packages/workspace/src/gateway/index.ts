/**
 * `@epicenter/workspace/gateway` — the node-only device gateway.
 *
 * The one process per device that owns the iroh endpoint (the ADR-0009 daemon
 * wearing one more hat). NODE-ONLY: this subpath pulls in `@number0/iroh` and
 * `node:child_process`, so it is deliberately kept out of the root barrel and
 * must never be imported by a browser build. Apps reach a gateway only through
 * the {@link PeerTransport} seam, never by importing iroh.
 */

export { createPeerGateway } from './gateway.js';
export type {
	DialOptions,
	PeerGateway,
	PeerGatewayOptions,
	RelayPreset,
} from './gateway.js';
export { loadOrCreateDeviceSecret } from './key-store.js';
export { createLocalGatewayTransport } from './local-gateway-transport.js';
export {
	alpnForRoute,
	alpnsForTable,
	meetsTrustThreshold,
	openRouteTarget,
	routeNameForAlpn,
	routeTrustThreshold,
} from './route-table.js';
export type {
	Route,
	RouteTable,
	RouteTarget,
	RouteTrustThreshold,
	SpawnRoute,
} from './route-table.js';
export {
	asPeerId,
	asRouteName,
	type ByteChannel,
	type OpenChannelOptions,
	type PeerId,
	type PeerTransport,
	type RouteName,
} from './transport.js';
export { biStreamToByteChannel, recvToReadable, sendToWritable } from './iroh-channel.js';
