/**
 * Shared auth types derived from the Better Auth config.
 *
 * These are the canonical types for the session shape returned by
 * `/auth/get-session`. Import from `@epicenter/api/types` instead
 * of hand-writing response types.
 */

import type { betterAuth } from 'better-auth';
import type { BASE_AUTH_CONFIG } from './app';

/** Better Auth instance type derived from the shared base config. */
type Auth = ReturnType<typeof betterAuth<typeof BASE_AUTH_CONFIG>>;

/** Full session object returned by `/auth/get-session`. Contains both session metadata and user info. */
export type Session = Auth['$Infer']['Session'];

/** The `session` portion of the get-session response (token, expiry, userId). */
export type SessionData = Session['session'];

/** The `user` portion of the get-session response (id, email, name, etc.). */
export type SessionUser = Session['user'];
