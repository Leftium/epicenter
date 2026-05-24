import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * A signed-in account identifier. Issued by Better Auth, opaque to clients.
 * In personal mode, the bytes happen to equal the owner id; in team mode
 * they do not. The brand prevents accidental cross-assignment.
 *
 * The validator is declared first; the type is derived from it via `.infer`
 * so schema and type stay in lockstep under one PascalCase name. Use
 * {@link UserId} directly inside schemas (`id: UserId`); at trusted call
 * sites that receive a known `string`, brand it with {@link asUserId}.
 */
export const UserId = type('string').as<string & Brand<'UserId'>>();
export type UserId = typeof UserId.infer;
/** Brand a known-string value as a {@link UserId}. Shorthand for `value as UserId`. */
export const asUserId = (value: string): UserId => value as UserId;

/**
 * Workspace partition key. In personal mode equals the signed-in user's
 * id (bytes preserve pre-collapse HKDF labels). In team mode the literal
 * 'team'. Every server path, every R2 key, every local IDB name, and the
 * HKDF derivation label all use this one value.
 *
 * The validator is declared first; the type is derived from it via `.infer`
 * so schema and type stay in lockstep under one PascalCase name. Use
 * {@link OwnerId} directly inside schemas (`ownerId: OwnerId`); at trusted
 * call sites brand a known `string` via {@link asOwnerId}.
 */
export const OwnerId = type('string').as<string & Brand<'OwnerId'>>();
export type OwnerId = typeof OwnerId.infer;
/** Brand a known-string value as an {@link OwnerId}. Shorthand for `value as OwnerId`. */
export const asOwnerId = (value: string): OwnerId => value as OwnerId;

/**
 * Deployment-static product shape. Set once at server construction
 * (`createServer({ mode, ... })`), flowed back to clients via
 * `/api/session`, persisted in the auth cell so the daemon knows the
 * shape offline. Drives URL pattern, sign-up policy, and team-aware UI.
 *
 * The validator is declared first; the type is derived from it via
 * `.infer` so schema and type stay in lockstep.
 */
export const OwnershipMode = type("'personal' | 'team'");
export type OwnershipMode = typeof OwnershipMode.infer;
