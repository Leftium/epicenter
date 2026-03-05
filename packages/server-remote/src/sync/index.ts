// Re-exports from sync-core used by remote server adapters
export {
	type ConnectionId,
	type ConnectionState,
	createMemoryUpdateLog,
	createRoomManager,
	handleHttpGetDoc,
	handleHttpSync,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	type UpdateLog,
} from '@epicenter/sync-core';
