/**
 * Shared auth types derived from the Better Auth config.
 *
 * These are the canonical types for the session shape returned by
 * `/auth/get-session`. Import from `@epicenter/api/types` instead
 * of hand-writing response types.
 */

import type { Session as BetterAuthSession, User as BetterAuthUser } from 'better-auth';
import type { CustomSessionFields } from './custom-session-fields';

/**
 * The `user` and `session` sub-objects come from Better Auth's base models.
 *
 * The top-level response is then composed with our portable custom-session
 * contract so consumers see the actual `/auth/get-session` payload without
 * importing the worker runtime or auth instance.
 */
export type Session = CustomSessionFields<BetterAuthUser, BetterAuthSession>;
