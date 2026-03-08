/**
 * @epicenter/sync-core — Framework-Agnostic Sync Primitives
 *
 * Pure TypeScript. Zero framework deps. Only yjs + lib0 + y-protocols.
 *
 * This package provides the core sync protocol logic that can be consumed
 * by any framework adapter (Elysia, Hono, Cloudflare Workers, etc.).
 */

// Re-export Awareness so consumers don't need a direct y-protocols dependency
export { Awareness } from 'y-protocols/awareness';
// Handlers (framework-agnostic WS connection lifecycle)
export {
	type ConnectionId,
	type ConnectionState,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	type WsMessageResult,
	type WsOpenResult,
} from './handlers';
// Protocol (encode/decode for WS messages and HTTP sync requests)
export {
	type DecodedSyncMessage,
	decodeMessageType,
	decodeSyncMessage,
	decodeSyncRequest,
	decodeSyncStatus,
	encodeAwareness,
	encodeAwarenessStates,
	encodeQueryAwareness,
	encodeSyncRequest,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncMessage,
	MESSAGE_TYPE,
	type MessageType,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
	stateVectorsEqual,
} from './protocol';
