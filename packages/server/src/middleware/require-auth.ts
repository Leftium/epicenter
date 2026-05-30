/**
 * Cookie-or-bearer authentication.
 *
 * Resolves `c.var.user` from a Better Auth session cookie if one is
 * present; otherwise falls back to an OAuth bearer for the API audience.
 * Use this on routes served to both first-party browser callers (portal,
 * dashboard, hosted UIs) and external OAuth clients (CLI, Tauri,
 * extension).
 *
 * For routes that are external-clients only (`/api/ai/*`, `/api/.../rooms/*`),
 * prefer {@link requireBearerUser}, which skips the cookie attempt.
 *
 * Ambiguous requests (both credentials present) never reach this
 * middleware; the global `singleCredential` middleware rejects them at
 * the edge.
 */

import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { AuthUser } from '@epicenter/auth';
import { OAuthError } from '@epicenter/constants/oauth-errors';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Ok, type Result } from 'wellcrafted/result';
import {
	createOAuthIssuerURL,
	createOAuthJwksURL,
} from '../auth/oauth-metadata.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { parseBearer } from '../auth/parse-bearer.js';
import * as schema from '../db/schema/index.js';
import type { Env } from '../types.js';

// `verifyAccessToken` carries no per-request state (`audience`, `issuer`,
// `jwksUrl` are passed per call), so resolve it once at module load.
const verifyAccessToken =
	oauthProviderResourceClient().getActions().verifyAccessToken;

/**
 * Resolve the OAuth bearer on the current request to the calling user.
 *
 * The API origin (`c.var.authBaseURL`) is the resource audience; the same
 * origin plus `/auth` is the issuer. Cheap by design: skips owner keyring
 * derivation, since only the calling user is needed once the token proves
 * issuer, audience, signature, expiration, and subject.
 */
async function resolveRequestOAuthUser(
	c: Context<Env>,
): Promise<Result<AuthUser, OAuthError>> {
	const accessToken = parseBearer(c.req.header('authorization') ?? null);
	if (!accessToken) return OAuthError.InvalidToken();

	const audience = c.var.authBaseURL;
	let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
	try {
		payload = await verifyAccessToken(accessToken, {
			verifyOptions: { audience, issuer: createOAuthIssuerURL(audience) },
			jwksUrl: createOAuthJwksURL(audience),
		});
	} catch (error) {
		// Separate "the token is bad" from "we could not reach the signing keys".
		// The former is a real 401; the latter (a JWKS fetch failure) must be a
		// retryable 503, or the client would discard and refresh a good token and
		// pause network auth over a transient server fault. See
		// {@link isTokenVerificationError}.
		return isTokenVerificationError(error)
			? OAuthError.InvalidToken()
			: OAuthError.ServerError();
	}
	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return OAuthError.InvalidToken();

	const user = await c.var.db.query.user.findFirst({
		where: eq(schema.user.id, userId),
	});
	if (!user) return OAuthError.InvalidToken();

	return Ok(AuthUser.assert(user));
}

/**
 * Distinguish a token-verification failure (expired, wrong audience/issuer,
 * bad signature, malformed) from an infrastructure failure (the JWKS endpoint
 * was unreachable so the token could not be checked at all).
 *
 * `jose` tags every token, claim, and signature failure with a stable `code`
 * that starts with `ERR_J` (e.g. `ERR_JWT_EXPIRED`,
 * `ERR_JWT_CLAIM_VALIDATION_FAILED`, `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`,
 * `ERR_JWKS_NO_MATCHING_KEY`), and Better Auth maps expired/invalid tokens to
 * an `UNAUTHORIZED` API error. A JWKS fetch failure is a plain `Error` with
 * neither marker, so it falls through to `ServerError`. If Better Auth ever
 * changes those internals this degrades safely back to the old behavior (treat
 * the failure as an invalid token).
 */
function isTokenVerificationError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	if ((error as { status?: unknown }).status === 'UNAUTHORIZED') return true;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' && code.startsWith('ERR_J');
}

export const requireCookieOrBearerUser = createMiddleware<Env>(
	async (c, next) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (session) {
			c.set('user', AuthUser.assert(session.user));
			return next();
		}
		const { data: user, error } = await resolveRequestOAuthUser(c);
		if (error) return createOAuthUnauthorizedResourceResponse(c, error);
		c.set('user', user);
		await next();
	},
);

/**
 * Bearer-only authentication. Same as {@link requireCookieOrBearerUser}
 * but skips the cookie path, so the route always reports 401 with a
 * standard OAuth `WWW-Authenticate` header instead of the cookie failure
 * path. Use on protected resource routes that should never see a browser
 * cookie (rooms, AI chat).
 */
export const requireBearerUser = createMiddleware<Env>(async (c, next) => {
	const { data: user, error } = await resolveRequestOAuthUser(c);
	if (error) return createOAuthUnauthorizedResourceResponse(c, error);
	c.set('user', user);
	await next();
});
