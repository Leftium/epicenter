/**
 * `@epicenter/workspace/gateway` — the node-only device route layer.
 *
 * The named route table the daemon serves over the relay floor, the relay-path
 * authorization gate, the route-child spawner, and the transport-blind MCP
 * catalog the agent loop consumes. NODE-ONLY: the route spawner pulls in
 * `node:child_process`, so this subpath is kept out of the root barrel and must
 * never be imported by a browser build. Apps reach a route only through the
 * {@link PeerTransport} seam.
 */

export {
	createMcpGatewayCatalog,
	type McpGatewayCatalog,
	type McpGatewayCatalogOptions,
} from '../agent/mcp-gateway-catalog.js';
export {
	createRelayRouteOpener,
	type RelayRouteOpenerOptions,
} from './relay-route.js';
export {
	DEFAULT_DEVICE_ROUTES,
	openRouteTarget,
	routeRelayExposed,
	withRelayExposed,
} from './route-table.js';
export type {
	Route,
	RouteTable,
	RouteTarget,
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
} from '../peer-transport.js';
