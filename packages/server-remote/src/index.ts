// Types
export type {
	ApiKeyBindings,
	SessionResult,
	Env,
	Variables,
} from './types';

// Factory
export { factory } from './factory';

// CORS
export { corsMiddleware } from './cors';

// Auth
export { baseAuthConfig, trustedClients } from './auth/better-auth-base';
export { authMiddleware } from './auth/middleware';
export {
	createOAuthMetadataHandler,
	createOidcConfigHandler,
} from './auth/oauth-discovery';

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
