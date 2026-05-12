import type { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { AuthUser, type WorkspaceIdentity } from '@epicenter/auth';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { User } from 'better-auth';

export const WORKSPACES_OPEN_SCOPE = 'workspaces:open';

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

type ResolveWorkspaceIdentityResult =
	| {
			status: 'resolved';
			body: WorkspaceIdentity;
	  }
	| { status: 'malformed' }
	| { status: 'invalid' }
	| { status: 'insufficient_scope'; requiredScope: string };

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
}): Promise<ResolveWorkspaceIdentityResult> {
	const accessToken = parseBearer(authorization);
	if (!accessToken) return { status: 'malformed' };

	const payload = await verifyOAuthAccessToken(accessToken, {
		verifyOptions: { audience, issuer },
		jwksUrl,
	}).catch(() => null);
	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return { status: 'invalid' };

	if (!hasScope(payload, WORKSPACES_OPEN_SCOPE)) {
		return { status: 'insufficient_scope', requiredScope: WORKSPACES_OPEN_SCOPE };
	}

	const user = await findUserById(userId);
	if (!user) return { status: 'invalid' };

	return {
		status: 'resolved',
		body: {
			user: AuthUser.assert(user),
			encryptionKeys: await deriveUserEncryptionKeys(user.id),
		},
	};
}

function hasScope(payload: unknown, required: string): boolean {
	if (payload === null || typeof payload !== 'object') return false;
	const raw = (payload as { scope?: unknown }).scope;
	if (typeof raw !== 'string') return false;
	return raw.split(/\s+/).filter(Boolean).includes(required);
}

function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}
