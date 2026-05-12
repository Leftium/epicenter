import type { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { AuthUser } from '@epicenter/auth';
import type { User } from 'better-auth';
import { hasScope, WORKSPACES_OPEN_SCOPE } from './oauth-scope.js';

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

export type OAuthPrincipalResult =
	| { status: 'resolved'; user: AuthUser }
	| { status: 'malformed' }
	| { status: 'invalid' }
	| { status: 'insufficient_scope'; requiredScope: string };

/**
 * Verify an OAuth access token and return the AuthUser principal for a
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
}): Promise<OAuthPrincipalResult> {
	const accessToken = parseBearer(authorization);
	if (!accessToken) return { status: 'malformed' };

	const payload = await verifyOAuthAccessToken(accessToken, {
		verifyOptions: { audience, issuer },
		jwksUrl,
	}).catch(() => null);
	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return { status: 'invalid' };

	if (!hasScope(payload, WORKSPACES_OPEN_SCOPE)) {
		return {
			status: 'insufficient_scope',
			requiredScope: WORKSPACES_OPEN_SCOPE,
		};
	}

	const user = await findUserById(userId);
	if (!user) return { status: 'invalid' };

	return {
		status: 'resolved',
		user: { id: user.id, email: user.email },
	};
}

function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}
