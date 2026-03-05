// App factory
export { createSharedApp } from './app';

// Types
export type {
	ApiKeyBindings,
	AuthInstance,
	SessionResult,
	SharedAppConfig,
	SharedEnv,
	Variables,
} from './types';

// Auth
export { baseAuthConfig } from './auth/better-auth-base';
export { createAuthMiddleware } from './auth/middleware';

// Proxy handlers
export { handleAiChat } from './proxy/chat';
export { handleProxy } from './proxy/passthrough';

// Sync re-exports
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
} from './sync';
