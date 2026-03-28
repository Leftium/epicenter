/**
 * Portable contract for the `/auth/get-session` response.
 *
 * Better Auth returns `{ user, session }`. Epicenter enriches that payload with
 * the current encryption key version so clients can detect stale local caches.
 * The actual encryption key material is served by a dedicated endpoint
 * (`GET /workspace-key`) rather than embedded in every session response.
 *
 * This file is intentionally runtime-free. Shared consumers should be able to
 * import the contract without pulling in Cloudflare Workers, Drizzle, or the
 * API's auth factory.
 */

import type {
	Session as BetterAuthSession,
	User as BetterAuthUser,
} from 'better-auth';

/**
 * Canonical `/auth/get-session` response for Epicenter clients.
 *
 * Extends Better Auth's base `{ user, session }` with `keyVersion` so clients
 * can detect stale encryption key caches without fetching key material.
 *
 * Import from `@epicenter/api/types` rather than hand-writing the response.
 */
export type EpicenterSessionResponse = {
	user: BetterAuthUser;
	session: BetterAuthSession;
	keyVersion: number;
};
