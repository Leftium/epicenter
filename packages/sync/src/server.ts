/**
 * @epicenter/sync/server — Server-Side Sync Handlers
 *
 * Framework-agnostic WebSocket lifecycle functions for Yjs sync servers.
 * Adapters (Elysia, Cloudflare Workers, etc.) call these handlers and
 * map the results to their transport layer.
 *
 * Import protocol primitives from `@epicenter/sync` (the default export).
 * Import these server handlers from `@epicenter/sync/server`.
 */

export {
	type ConnectionId,
	type ConnectionState,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	type WsMessageResult,
	type WsOpenResult,
} from './handlers';
