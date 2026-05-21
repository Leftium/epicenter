import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { AuthUser } from '@epicenter/auth';
import type { User } from 'better-auth';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Context } from 'hono';
import { Err, Ok, type Result } from 'wellcrafted/result';
import * as schema from '../db/schema';
import {
	hasWorkspaceOpenScope,
	OAuthError,
	WORKSPACES_OPEN_SCOPE,
} from './oauth-error.js';
import { createOAuthIssuerURL, createOAuthJwksURL } from './oauth-metadata.js';

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

type ResolverDeps = {
	authorization: string | null;
	audience: string;
	issuer: string;
	jwksUrl: string;
	verifyOAuthAccessToken: VerifyOAuthAccessToken;
	findUserById(userId: string): Promise<User | null>;
};

type RequestOAuthEnv = {
	Bindings: object | undefined;
	Variables: {
		authBaseURL: string;
		db: NodePgDatabase<typeof schema>;
	};
};

/**
 * Extract the token from an HTTP `Authorization: Bearer <token>` header value.
 * Case-insensitive on the scheme; trims surrounding whitespace; returns null
 * for missing, empty, or non-bearer inputs.
 *
 * Shared with `single-credential.ts` so well-formedness and authorization
 * agree on what counts as a bearer.
 */
export function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

/**
 * Verify a bearer access token, enforce the `workspaces:open` scope, and
 * resolve the calling Better Auth user. The single source of truth for what
 * "a token good enough to reach a protected resource" means in this codebase.
 *
 * `resolveBearerUser` projects the Better Auth `User` through
 * `AuthUser.assert` once the bearer has passed all resource checks.
 */
async function verifyBearerToUser(
	deps: ResolverDeps,
): Promise<Result<User, OAuthError>> {
	const accessToken = parseBearer(deps.authorization);
	if (!accessToken) return OAuthError.InvalidToken();

	const payload = await deps
		.verifyOAuthAccessToken(accessToken, {
			verifyOptions: { audience: deps.audience, issuer: deps.issuer },
			jwksUrl: deps.jwksUrl,
		})
		.catch(() => null);
	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return OAuthError.InvalidToken();

	if (!hasWorkspaceOpenScope(payload)) {
		return OAuthError.InsufficientScope({ scope: WORKSPACES_OPEN_SCOPE });
	}

	const user = await deps.findUserById(userId);
	if (!user) return OAuthError.InvalidToken();

	return Ok(user);
}

/**
 * Cheap resolver for the protected-resource boundary (`/ai/*`,
 * `/rooms/*`, `/api/billing/*`, `/api/assets/*`).
 * Skips subject keyring derivation; only the calling user is needed once
 * the scope is proven.
 */
export async function resolveBearerUser(
	deps: ResolverDeps,
): Promise<Result<AuthUser, OAuthError>> {
	const { data: user, error } = await verifyBearerToUser(deps);
	if (error) return Err(error);
	return Ok(AuthUser.assert(user));
}

/**
 * Resolve the OAuth bearer on the current request to the calling user.
 * This is the Hono adapter around the pure bearer resolver above.
 */
export function resolveRequestOAuthUser<E extends RequestOAuthEnv>(
	c: Context<E>,
) {
	return resolveBearerUser(createResolverDeps(c));
}

function createResolverDeps<E extends RequestOAuthEnv>(c: Context<E>) {
	const audience = c.var.authBaseURL;
	return {
		authorization: c.req.header('authorization') ?? null,
		audience,
		issuer: createOAuthIssuerURL(audience),
		jwksUrl: createOAuthJwksURL(audience),
		verifyOAuthAccessToken:
			oauthProviderResourceClient().getActions().verifyAccessToken,
		findUserById: async (userId) => {
			const [row] = await c.var.db
				.select()
				.from(schema.user)
				.where(eq(schema.user.id, userId))
				.limit(1);
			return row ?? null;
		},
	} satisfies ResolverDeps;
}
