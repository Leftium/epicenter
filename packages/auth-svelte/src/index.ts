export {
	AuthError,
	type WorkspaceIdentity,
	type AuthState,
	AuthUser,
	type CreateOAuthAppAuthConfig,
	OAuthSession,
	type OAuthSessionStorage,
	type OAuthSignInLauncher,
	type OAuthTokenRefresher,
	type OAuthTokenResult,
} from '@epicenter/auth';
export {
	type AuthClient,
	createOAuthAppAuth,
} from './create-auth.svelte.js';
