import type { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { WorkspaceIdentity } from '@epicenter/auth';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { User } from 'better-auth';
import { createAuthIdentityResponse } from './identity-response.js';

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

type ResolveOAuthIdentityResult =
	| {
			status: 'resolved';
			body: WorkspaceIdentity;
	  }
	| { status: 'malformed' }
	| { status: 'invalid' };

export async function resolveOAuthIdentity({
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
}): Promise<ResolveOAuthIdentityResult> {
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
		body: await createAuthIdentityResponse(
			{ user },
			{ deriveUserEncryptionKeys },
		),
	};
}

function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}
