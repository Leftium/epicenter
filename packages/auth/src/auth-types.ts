import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';

export const AuthUser = type({
	'+': 'delete',
	id: 'string',
	email: 'string',
});

export type AuthUser = typeof AuthUser.infer;

/**
 * OAuth token grant. Persisted under `PersistedAuth.grant`.
 *
 * Server-access material: required to call `/api/*` online; offline-useless
 * on its own. Refresh tokens rotate on every successful refresh.
 */
export const OAuthTokenGrant = type({
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});

export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

/**
 * Device capability to decrypt local Yjs data without the server. Persisted
 * under `PersistedAuth.unlock`. `userId` binds the keyring to a subject for
 * the same-user guard at `/api/me` response.
 */
export const LocalUnlockBundle = type({
	'+': 'delete',
	userId: 'string',
	encryptionKeys: EncryptionKeys,
});

export type LocalUnlockBundle = typeof LocalUnlockBundle.infer;

/**
 * The single persisted auth cell. Two clearly-labeled sections.
 *
 * Browser persists to localStorage, extension to chrome.storage.local, CLI
 * to `~/.epicenter/auth.json` (mode 0o600). All three cells validate against
 * this arktype. Profile data is intentionally absent; application surfaces
 * fetch it when they display it.
 */
export const PersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	unlock: LocalUnlockBundle,
});

export type PersistedAuth = typeof PersistedAuth.infer;
