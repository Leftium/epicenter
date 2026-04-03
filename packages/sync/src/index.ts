/**
 * @epicenter/sync — Yjs Sync Protocol Primitives
 *
 * Pure encode/decode functions for the y-websocket wire protocol.
 * Zero framework deps. Only yjs + lib0 + y-protocols.
 *
 * For server-side WebSocket lifecycle handlers, import from
 * `@epicenter/sync/server` instead.
 */

// Protocol (encode/decode for WS messages and HTTP sync requests)
export {
	type DecodedRpcMessage,
	type DecodedSyncMessage,
	decodeMessageType,
	decodeRpcMessage,
	decodeSyncMessage,
	decodeSyncRequest,
	decodeSyncStatus,
	encodeAwareness,
	encodeAwarenessStates,
	encodeQueryAwareness,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncRequest,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	type MessageType,
	RPC_TYPE,
	type RpcType,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
	stateVectorsEqual,
} from './protocol';
