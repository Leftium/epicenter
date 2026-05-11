import {
	AuthIdentity,
	OAuthSession,
	type OAuthSession as OAuthSessionType,
} from '../auth-types.js';

export type AuthSessionResponse = AuthIdentity;
export type OAuthTokenFields = Pick<
	OAuthSessionType,
	'accessToken' | 'refreshToken' | 'accessTokenExpiresAt'
>;

/**
 * Validate the API auth-session response as local identity state.
 *
 * App auth needs identity and encryption keys from the resource server. OAuth
 * tokens attach separately instead of depending on server session shape.
 */
export function authIdentityFromAuthSessionResponse(
	value: unknown,
): AuthIdentity | null {
	if (value === null || value === undefined) return null;

	return AuthIdentity.assert(value);
}

/**
 * Attach a bearer token to the API auth-session response.
 *
 * Better Auth's client plugin typing cannot carry this response through every
 * package boundary in this monorepo, so this function owns the runtime check
 * instead of letting callers trust an inline cast.
 */
export function oauthSessionFromAuthSessionResponse(
	value: unknown,
	tokens: OAuthTokenFields,
): OAuthSessionType {
	const identity = authIdentityFromAuthSessionResponse(value);
	if (identity === null) {
		throw new Error('Expected auth-session response to be signed in.');
	}
	return OAuthSession.assert({
		...tokens,
		user: identity.user,
		encryptionKeys: identity.encryptionKeys,
	});
}
