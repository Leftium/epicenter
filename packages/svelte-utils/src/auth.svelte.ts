export {
	AuthCommandError,
	type AuthClient,
	type AuthCommandResult,
	type AuthRefreshResult,
	type CreateAuthSessionOptions,
	createAuthSession,
} from './auth-session.svelte.js';
export {
	type BetterAuthTransportClient,
	createBetterAuthClientSession,
	createSessionResolver,
	type RemoteAuthResult,
	type ResolveSession,
	resolveSessionWithToken,
	type SessionResolution,
	startGoogleSignInRedirect,
	signInWithPassword,
	signOutRemote,
	signUpWithPassword,
} from './auth-transport.js';
export {
	type AuthOperation,
	AuthSession,
	type AuthSession as AuthSessionSnapshot,
	type AuthSessionStorage,
	PersistedSession,
	type PersistedSession as PersistedSessionSnapshot,
	StoredUser,
} from './auth-types.js';
export {
	createWorkspaceAuth,
	type CreateWorkspaceAuthOptions,
	type WorkspaceAuth,
} from './workspace-auth.svelte.js';
