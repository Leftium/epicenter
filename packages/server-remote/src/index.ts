// Types
export type {
	ApiKeyBindings,
	AuthWithOAuth,
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
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';

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
