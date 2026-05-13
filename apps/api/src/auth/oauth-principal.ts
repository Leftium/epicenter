import type { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { AuthUser } from '@epicenter/auth';
import type { User } from 'better-auth';
import { Ok, type Result } from 'wellcrafted/result';
import {
	hasScope,
	OAuthError,
	WORKSPACES_OPEN_SCOPE,
} from './oauth-error.js';

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

/**
 * Verify an OAuth access token and return the `AuthUser` principal for a
 * protected resource route. Enforces the `workspaces:open` scope so a
 * token issued for, say, `openid profile email` cannot reach `/workspaces/*`,
 * `/documents/*`, `/api/billing/*`, `/api/assets/*`, or `/ai/*`.
 *
 * Cheaper than `resolveWorkspaceIdentity`: skips encryption-key derivation,
 * since protected resources only need the calling user once the scope is proven.
 */
export async function resolveOAuthPrincipal({
	authorization,
	audience,
	issuer,
	jwksUrl,
	verifyOAuthAccessToken,
	findUserById,
}: {
	authorization: string | null;
	audience: string;
	issuer: string;
	jwksUrl: string;
	verifyOAuthAccessToken: VerifyOAuthAccessToken;
	findUserById(userId: string): Promise<User | null>;
}): Promise<Result<AuthUser, OAuthError>> {
	const accessToken = parseBearer(authorization);
	if (!accessToken) return OAuthError.InvalidToken();

	const payload = await verifyOAuthAccessToken(accessToken, {
		verifyOptions: { audience, issuer },
		jwksUrl,
	}).catch(() => null);
	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return OAuthError.InvalidToken();

	if (!hasScope(payload, WORKSPACES_OPEN_SCOPE)) {
		return OAuthError.InsufficientScope({ scope: WORKSPACES_OPEN_SCOPE });
	}

	const user = await findUserById(userId);
	if (!user) return OAuthError.InvalidToken();

	return Ok({ id: user.id, email: user.email });
}

function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}
