import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';

export const AuthUser = type({
	'+': 'delete',
	id: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type AuthUser = typeof AuthUser.infer;

export const AuthIdentity = type({
	'+': 'delete',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type AuthIdentity = typeof AuthIdentity.infer;

/** OAuth auth state persisted by browser, extension, and machine clients. */
export const OAuthSession = type({
	'...': AuthIdentity,
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});

export type OAuthSession = typeof OAuthSession.infer;
