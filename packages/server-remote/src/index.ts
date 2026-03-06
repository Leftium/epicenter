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
export type {
	ApiKeyBindings,
	AuthWithOAuth,
	Env,
	SessionResult,
	Variables,
} from './types';
