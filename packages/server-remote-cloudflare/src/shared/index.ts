export {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
export { baseAuthConfig, trustedClients } from './auth/better-auth-base';
export { authMiddleware } from './auth/middleware';
export { corsMiddleware } from './cors';
export { factory } from './factory';
export { handleAiChat } from './ai-chat';
export type {
	ApiKeyBindings,
	AuthWithOAuth,
	Env,
	SessionResult,
	Variables,
} from './types';
