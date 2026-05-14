import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';

export const AuthUser = type({
	'+': 'delete',
	id: 'string',
	email: 'string',
});

export type AuthUser = typeof AuthUser.infer;

export const WorkspaceIdentity = type({
	'+': 'delete',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type WorkspaceIdentity = typeof WorkspaceIdentity.infer;

/** Parsed OAuth token grant used before identity loading. */
export const OAuthTokenGrant = type({
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});

export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

/** OAuth auth state persisted by browser, extension, and machine clients. */
export const OAuthSession = type({
	'+': 'delete',
	tokens: OAuthTokenGrant,
	identity: WorkspaceIdentity,
});

export type OAuthSession = typeof OAuthSession.infer;
