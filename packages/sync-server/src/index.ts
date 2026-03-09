/**
 * @epicenter/sync-server — Server-Side Sync Handlers
 *
 * Framework-agnostic WS connection lifecycle. Adapters (Hono/Bun, Cloudflare
 * Durable Objects) call these handlers and map the results to their transport.
 */

// Re-export Awareness so server consumers don't need a direct y-protocols dependency
export { Awareness } from 'y-protocols/awareness';
export {
	type ConnectionId,
	type ConnectionState,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	type WsMessageResult,
	type WsOpenResult,
} from './handlers';
