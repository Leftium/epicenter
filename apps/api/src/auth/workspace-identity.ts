import type { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { AuthUser, type WorkspaceIdentity } from '@epicenter/auth';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { User } from 'better-auth';
import { Ok, type Result } from 'wellcrafted/result';
import {
	hasScope,
	OAuthError,
	WORKSPACES_OPEN_SCOPE,
} from './oauth-error.js';

export { WORKSPACES_OPEN_SCOPE };

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

/**
 * Verify an OAuth access token, enforce the `workspaces:open` scope, and
 * return the local-first identity payload the apps need at boot:
 * the resolved `AuthUser` plus the per-user encryption key set derived
 * from the workspace identity secret.
 *
 * Shares the same failure vocabulary (`OAuthError`) as
 * `resolveOAuthPrincipal`, so the `/workspace-identity` route and the
 * protected resource middleware can serialize errors identically.
 */
export async function resolveWorkspaceIdentity({
	authorization,
	audience,
	issuer,
	jwksUrl,
	verifyOAuthAccessToken,
	findUserById,
	deriveUserEncryptionKeys,
}: {
	authorization: string | null;
	audience: string;
	issuer: string;
	jwksUrl: string;
	verifyOAuthAccessToken: VerifyOAuthAccessToken;
	findUserById(userId: string): Promise<User | null>;
	deriveUserEncryptionKeys(userId: string): Promise<EncryptionKeys>;
}): Promise<Result<WorkspaceIdentity, OAuthError>> {
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

	return Ok({
		user: AuthUser.assert(user),
		encryptionKeys: await deriveUserEncryptionKeys(user.id),
	});
}

function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}
