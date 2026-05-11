import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';

/**
 * JSON-safe user snapshot shared by auth sessions.
 *
 * Better Auth can produce `Date` objects before serialization. The auth
 * contract normalizes those dates to ISO strings once so every persisted store
 * uses the same user shape.
 */
export const AuthUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type AuthUser = typeof AuthUser.infer;

export const AuthIdentity = type({
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type AuthIdentity = typeof AuthIdentity.infer;

/** OAuth auth state persisted by browser, extension, and machine clients. */
export const OAuthSession = type({
	'...': AuthIdentity,
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});

export type OAuthSession = typeof OAuthSession.infer;
