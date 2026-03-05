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
// Discovery (device discovery via Yjs Awareness)
export {
	createClientPresence,
	createLocalPresence,
	type DeviceCapability,
	type DeviceType,
	DISCOVERY_ROOM_ID,
	type DiscoveryState,
	getDiscoveredDevices,
} from './discovery';
// Handlers (framework-agnostic request/message handlers)
export {
	type ConnectionId,
	type ConnectionState,
	handleHttpGetDoc,
	handleHttpSync,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	type WsMessageResult,
	type WsOpenResult,
} from './handlers';
// Protocol (WS encode/decode)
export {
	type DecodedSyncMessage,
	decodeMessageType,
	decodeSyncMessage,
	decodeSyncStatus,
	encodeAwareness,
	encodeAwarenessStates,
	encodeQueryAwareness,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncMessage,
	MESSAGE_TYPE,
	type MessageType,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
} from './protocol';
// Providers (AI provider constants)
export {
	isSupportedProvider,
	PROVIDER_ENV_VARS,
	SUPPORTED_PROVIDERS,
	type SupportedProvider,
} from './providers';
// Rooms (connection lifecycle)
export { createRoomManager } from './rooms';
// Storage (HTTP sync persistence)
export {
	compactDoc,
	createMemorySyncStorage,
	decodeSyncRequest,
	encodeSyncRequest,
	type SyncStorage,
	stateVectorsEqual,
} from './storage';
