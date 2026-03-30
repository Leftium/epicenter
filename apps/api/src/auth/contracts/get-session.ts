/**
 * Portable contract for the `/auth/get-session` response.
 *
 * Better Auth returns `{ user, session }`. Epicenter enriches that payload with
 * the current encryption key version and derived user key so clients can unlock
 * their workspace without a separate round-trip.
 *
 * This file is intentionally runtime-free. Shared consumers should be able to
 * import the contract without pulling in Cloudflare Workers, Drizzle, or the
 * API's auth factory.
 */

import type {
	Session,
	User,
} from 'better-auth';

/**
 * Canonical `/auth/get-session` response for Epicenter clients.
 *
 * Extends Better Auth's base `{ user, session }` with `keyVersion` and
 * `userKeyBase64` so clients can unlock their workspace directly from the
 * session—no separate key-fetch endpoint needed.
 *
 * Import from `@epicenter/api/types` rather than hand-writing the response.
 */
export type SessionResponse = {
	user: User;
	session: Session;
	keyVersion: number;
	userKeyBase64: string;
};
