export {
	type CreateAppAuthClientOptions,
	createAppAuthClient,
} from './app-auth-client.js';
export type {
	AuthClient,
	AuthFetch,
	AuthState,
	SyncAuthClient,
} from './auth-contract.js';
export * from './auth-errors.js';
export {
	ApiSessionResponse,
	AuthUser,
	asUserId,
	UserId,
} from './auth-types.js';
export {
	type CreateOAuthAppAuthConfig,
	createOAuthAppAuth,
} from './create-oauth-app-auth.js';
export {
	type Instance,
	InstanceError,
	normalizeInstanceUrl,
} from './instance.js';
export {
	createInstanceSetting,
	type InstanceSetting,
	loadInstanceSetting,
} from './instance-setting.js';
// The pure pieces of the single-partition instance bearer (self-host; ADR-0075):
// `generateInstanceToken` mints a strong token (`gen-token`), `assertStrongToken`
// is the boot entropy gate. They live here (not `@epicenter/server`) so a token
// can be generated and validated without the server graph. The verifier side
// (`createInstanceTokenResolver`, `verifyEnvToken`) stays in `@epicenter/server`.
export {
	assertStrongToken,
	generateInstanceToken,
	MIN_INSTANCE_TOKEN_CHARS,
} from './instance-token.js';
export {
	type CreateInstanceTokenAuthConfig,
	createInstanceTokenAuth,
} from './instance-token-auth.js';
export {
	createWebStoragePersistedAuthStorage,
	loadPersistedAuthStorage,
	type PersistedAuthStorage,
} from './persisted-auth-storage.js';
export {
	type CreateSameOriginCookieAuthConfig,
	createSameOriginCookieAuth,
} from './same-origin-cookie-auth.js';
