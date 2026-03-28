/**
 * Portable contract for the `/auth/get-session` response.
 *
 * Better Auth returns `{ user, session }`. Epicenter enriches that payload with
 * encryption metadata so clients can unlock encrypted workspace data as soon as
 * the session loads. These fields appear only on `getSession()` responses.
 * `signIn` and `signUp` responses do not include them.
 *
 * This file intentionally stays lightweight so other packages can import it
 * without pulling in Cloudflare Workers, Drizzle, or the API runtime.
 */

import type {
	Session as BetterAuthSession,
	User as BetterAuthUser,
} from 'better-auth';

/**
 * Extra fields Epicenter adds to the base Better Auth session payload.
 *
 * The server derives a per-user encryption key via HKDF and returns it
 * alongside the standard session and user data.
 */
export type EpicenterSessionFields = {
	userKeyBase64: string;
	keyVersion: number;
};

/**
 * Generic shape of Epicenter's enriched `getSession()` response.
 *
 * This stays generic so server code can plug in concrete Better Auth
 * `user` and `session` types, while consumers can compose the same contract
 * without importing the auth instance.
 */
export type GetSessionResponse<User = unknown, Session = unknown> = {
	user: User;
	session: Session;
} & EpicenterSessionFields;

/**
 * Canonical `/auth/get-session` response for Epicenter clients.
 *
 * Import from `@epicenter/api/types` rather than hand-writing the response.
 */
export type EpicenterSessionResponse = GetSessionResponse<
	BetterAuthUser,
	BetterAuthSession
>;
