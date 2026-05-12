import type { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { AuthUser } from '@epicenter/auth';
import type { User } from 'better-auth';

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

export type OAuthPrincipalResult =
	| { status: 'resolved'; user: AuthUser }
	| { status: 'malformed' }
	| { status: 'invalid' };

/**
 * Verify an OAuth access token and return the AuthUser principal.
 *
 * Cheaper than `resolveWorkspaceIdentity`: skips encryption key derivation
 * and the workspaces:open scope check, since protected resources only need
 * to know which user is calling them.
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
