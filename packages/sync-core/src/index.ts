/**
 * @epicenter/sync-core — Framework-Agnostic Sync Primitives
 *
 * Pure TypeScript. Zero framework deps. Only yjs + lib0 + y-protocols.
 *
 * This package provides the core sync protocol logic that can be consumed
 * by any framework adapter (Elysia, Hono, Cloudflare Workers, etc.).
 */

// Auth
export { extractBearerToken, type TokenVerifier } from './auth';

// Protocol (WS encode/decode)
export {
	MESSAGE_TYPE,
	type MessageType,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
	type DecodedSyncMessage,
	decodeMessageType,
	decodeSyncMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncMessage,
	encodeSyncStatus,
	decodeSyncStatus,
	encodeAwareness,
	encodeAwarenessStates,
	encodeQueryAwareness,
} from './protocol';

// Rooms (connection lifecycle)
export { createRoomManager } from './rooms';

// Storage (HTTP sync persistence)
export {
	type SyncStorage,
	encodeSyncRequest,
	decodeSyncRequest,
	stateVectorsEqual,
	createMemorySyncStorage,
	compactDoc,
} from './storage';

// Handlers (framework-agnostic request/message handlers)
export {
	type ConnectionId,
	type ConnectionState,
	type WsOpenResult,
	type WsMessageResult,
	handleWsOpen,
	handleWsMessage,
	handleWsClose,
	handleHttpSync,
	handleHttpGetDoc,
} from './handlers';
