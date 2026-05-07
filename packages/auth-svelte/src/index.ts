export {
	AuthError,
	type AuthIdentity,
	type AuthState,
	type AuthStateChangeListener,
	AuthUser,
	BearerSession,
	type CreateBearerAuthConfig,
	type CreateCookieAuthConfig,
	waitForAuthSettled,
	waitForAuthState,
} from '@epicenter/auth';
export {
	type AuthClient,
	createBearerAuth,
	createCookieAuth,
} from './create-auth.svelte.ts';
