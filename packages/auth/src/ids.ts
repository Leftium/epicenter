import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * A signed-in account identifier. Issued by Better Auth, opaque to clients.
 * In personal mode, the bytes happen to equal the owner id; in team mode
 * they do not. The brand prevents accidental cross-assignment.
 */
export type UserId = string & Brand<'UserId'>;
export const UserId = type('string').as<UserId>();

/**
 * Workspace partition key. In personal mode equals the signed-in user's
 * id (bytes preserve pre-collapse HKDF labels). In team mode the literal
 * 'team'. Every server path, every R2 key, every local IDB name, and the
 * HKDF derivation label all use this one value.
 */
export type OwnerId = string & Brand<'OwnerId'>;
export const OwnerId = type('string').as<OwnerId>();

/**
 * Deployment-static product shape. Set once at server construction
 * (`createServer({ mode, ... })`), flowed back to clients via
 * `/api/session`, persisted in the auth cell so the daemon knows the
 * shape offline. Drives URL pattern, sign-up policy, and team-aware UI.
 */
export type OwnershipMode = 'personal' | 'team';
export const OwnershipMode = type("'personal' | 'team'");
