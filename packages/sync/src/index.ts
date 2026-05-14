/**
 * @epicenter/sync — Yjs Sync Protocol Primitives
 *
 * Encode/decode functions for the y-websocket wire protocol.
 *
 * After the RPC-on-Yjs-state collapse, the wire carries only Yjs sync
 * frames (`SYNC` = 0); `AUTH` (2) remains as a reserved sentinel for the
 * 4401 close path but no frames are exchanged. Identity, presence, and
 * remote calls now live as rows in reserved Y.Doc arrays.
 *
 * For server-side WebSocket lifecycle handlers, import from
 * `@epicenter/sync/server` instead.
 */

// WebSocket subprotocol auth (shared client/server constants + helpers)
export {
	BEARER_SUBPROTOCOL_PREFIX,
	extractBearerToken,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from './auth-subprotocol';
// Transport origin sentinels (shared across all sync layers)
export {
	BC_ORIGIN,
	isTransportOrigin,
	SYNC_ORIGIN,
} from './origins';
// Protocol (encode/decode for WS messages and HTTP sync requests)
export {
	decodeMessageType,
	decodeSyncMessage,
	decodeSyncRequest,
	encodeSyncRequest,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
	stateVectorsEqual,
} from './protocol';
