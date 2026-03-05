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
export { baseAuthConfig, trustedClients } from './auth/better-auth-base';
export { createAuthMiddleware } from './auth/middleware';

// Proxy handlers
export { handleAiChat } from './proxy/chat';
export { handleProxy } from './proxy/passthrough';

// Sync re-exports
export {
	createRoomManager,
	createMemoryUpdateLog,
	handleWsOpen,
	handleWsMessage,
	handleWsClose,
	handleHttpSync,
	handleHttpGetDoc,
	type UpdateLog,
	type ConnectionId,
	type ConnectionState,
} from './sync';
