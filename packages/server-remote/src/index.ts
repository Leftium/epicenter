// Types

export {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
// Auth
export { baseAuthConfig, trustedClients } from './auth/better-auth-base';
export { authMiddleware } from './auth/middleware';
// CORS
export { corsMiddleware } from './cors';
// Factory
export { factory } from './factory';
// AI chat handler
export { handleAiChat } from './ai-chat';
// Sync re-exports
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
} from './sync';
export type {
	ApiKeyBindings,
	AuthWithOAuth,
	Env,
	SessionResult,
	Variables,
} from './types';
