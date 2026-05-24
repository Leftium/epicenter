import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * A signed-in account identifier. Issued by Better Auth, opaque to clients.
 * In personal mode, the bytes happen to equal the owner id; in team mode
 * they do not. The brand prevents accidental cross-assignment.
 *
 * Use the {@link UserId} constructor to brand a known-string value:
 * `UserId(c.var.user.id)`. The constructor is a typed cast, not a runtime
 * validator; arktype validation at network/disk boundaries uses
 * {@link UserIdSchema}.
 */
export type UserId = string & Brand<'UserId'>;
export const UserId = (value: string): UserId => value as UserId;
/** Arktype validator that produces a branded {@link UserId}. Use inside schemas. */
export const UserIdSchema = type('string').as<UserId>();

/**
 * Workspace partition key. In personal mode equals the signed-in user's
 * id (bytes preserve pre-collapse HKDF labels). In team mode the literal
 * 'team'. Every server path, every R2 key, every local IDB name, and the
 * HKDF derivation label all use this one value.
 *
 * Use the {@link OwnerId} constructor to brand a known-string value:
 * `OwnerId(rawString)`. The constructor is a typed cast, not a runtime
 * validator; arktype validation at network/disk boundaries uses
 * {@link OwnerIdSchema}.
 */
export type OwnerId = string & Brand<'OwnerId'>;
export const OwnerId = (value: string): OwnerId => value as OwnerId;
/** Arktype validator that produces a branded {@link OwnerId}. Use inside schemas. */
export const OwnerIdSchema = type('string').as<OwnerId>();

/**
 * Deployment-static product shape. Set once at server construction
 * (`createServer({ mode, ... })`), flowed back to clients via
 * `/api/session`, persisted in the auth cell so the daemon knows the
 * shape offline. Drives URL pattern, sign-up policy, and team-aware UI.
 *
 * The exported value is the arktype validator; the exported type is derived
 * from it so schema and type stay in lockstep.
 */
export const OwnershipMode = type("'personal' | 'team'");
export type OwnershipMode = typeof OwnershipMode.infer;
