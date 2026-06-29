/**
 * `@epicenter/workspace/relay-channel` — the relay floor.
 *
 * The browser-safe half of the universal device-channel relay: typed
 * request/response channels multiplexed over the account-room WebSocket each
 * device already holds, behind the {@link PeerTransport} seam. Pure TypeBox
 * protocol plus a browser-safe transport; it pulls no node builtin and never
 * imports `@number0/iroh`, so it is the floor a browser uses with no app.
 *
 * The server-side routing of these frames lives in
 * `packages/server/src/room/channel-router.ts`; the two share only the wire
 * {@link ./protocol} module.
 */

export * from './acceptor.js';
export * from './channel-bytes.js';
export * from './channel-port.js';
export * from './protocol.js';
export * from './transport.js';
