// Re-exports from sync-core used by remote server adapters
export {
	createRoomManager,
	createMemorySyncStorage,
	handleWsOpen,
	handleWsMessage,
	handleWsClose,
	handleHttpSync,
	handleHttpGetDoc,
	type SyncStorage,
	type ConnectionId,
	type ConnectionState,
} from '@epicenter/sync-core';
