/**
 * Dev-only credential bypass for the self-host runtime smoke.
 *
 * `Authorization: Bearer dev:<userId>` resolves to the user
 * `{ id: <userId>, email: <userId>@dev.invalid }` with no interactive login, so
 * a smoke can drive the authed surfaces without Google OAuth. In shared mode the
 * resolved email is exactly what `admit` checks against `ALLOWED_MEMBER_EMAILS`,
 * so a smoke proves BOTH outcomes: an allowlisted dev email is admitted, a
 * stranger gets 403 NotAdmitted.
 *
 * This IS a bypass, so it is quarantined: wired ONLY by `server.dev.ts`, which
 * the production entrypoints (`worker/index.ts`, `server.ts`) never import, so it
 * cannot ship. It is duplicated from `apps/api/dev-auth.ts` on purpose: each
 * deployable owns its own bypass so neither can leak the other's, and the bypass
 * stays OUT of the shared library where an env-gated branch would compile it into
 * production (ADR-0066). Belt-and-suspenders: it refuses unless the request
 * landed on localhost, so even a misconfigured deploy that somehow wired it would
 * admit nobody off-box.
 */

import { AuthUser, asUserId } from '@epicenter/auth';
import { OAuthError } from '@epicenter/constants/oauth-errors';
import type { ResolveUser } from '@epicenter/server/bun';
import { Ok } from 'wellcrafted/result';

const BEARER_PREFIX = 'Bearer ';
const DEV_TOKEN_PREFIX = 'dev:';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Resolve `Authorization: Bearer dev:<userId>` to a synthetic user, on localhost
 * only. Any other request (off-box, missing header, non-`dev:` token, empty id)
 * is an `InvalidToken`, the same `Result` arm the real resolver returns, so the
 * surface wrappers reject it unchanged.
 */
export const resolveDevUser: ResolveUser = async (c) => {
	const hostname = new URL(c.req.url).hostname;
	if (!LOCAL_HOSTNAMES.has(hostname)) return OAuthError.InvalidToken();

	const header = c.req.header('authorization') ?? '';
	const token = header.startsWith(BEARER_PREFIX)
		? header.slice(BEARER_PREFIX.length)
		: '';
	if (!token.startsWith(DEV_TOKEN_PREFIX)) return OAuthError.InvalidToken();

	const userId = token.slice(DEV_TOKEN_PREFIX.length);
	if (!userId) return OAuthError.InvalidToken();

	return Ok(
		AuthUser.assert({ id: asUserId(userId), email: `${userId}@dev.invalid` }),
	);
};
