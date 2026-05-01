/**
 * Portable contract for the `/auth/get-session` response.
 *
 * Better Auth returns `{ user, session }`. Epicenter enriches that payload with
 * the full encryption keyring (derived per-user keys for every active secret
 * version) so clients can unlock their workspace without a separate round-trip.
 *
 * This file is intentionally runtime-free. Shared consumers should be able to
 * import the contract without pulling in Cloudflare Workers, Drizzle, or the
 * API's auth factory.
 */

export type { SessionResponse } from '@epicenter/auth/contracts';
