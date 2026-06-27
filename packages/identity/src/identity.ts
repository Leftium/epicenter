import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * Workspace partition key. In personal mode equals the signed-in user's
 * id (bytes preserve pre-collapse HKDF labels). In shared mode the literal
 * 'shared'. Every server path, every R2 key, every local IDB name, and the
 * HKDF derivation label all use this one value.
 *
 * Deployment shape (personal vs shared) is never carried as its own field: it is
 * a property of the server, not of any cell or wire payload. This is the
 * canonical site for the rare consumer that genuinely must distinguish them:
 * derive it as `ownerId === SHARED_OWNER_ID` (shared) versus
 * `ownerId === userId` (personal). Most code should not branch at all and just
 * use `ownerId` as the opaque partition key.
 *
 * The validator is declared first; the type is derived from it via `.infer`
 * so schema and type stay in lockstep under one PascalCase name. Use
 * {@link OwnerId} directly inside schemas (`ownerId: OwnerId`); at trusted
 * call sites brand a known `string` via {@link asOwnerId}.
 */
export const OwnerId = type('string').as<string & Brand<'OwnerId'>>();
export type OwnerId = typeof OwnerId.infer;
/**
 * Syntactic sugar for `value as OwnerId`. The function body is a single typed
 * cast; the constrained `string` parameter is what earns it over a raw `as`
 * (callers can't accidentally widen to `unknown`). The only place in the
 * codebase where `as OwnerId` appears.
 */
export const asOwnerId = (value: string): OwnerId => value as OwnerId;

/**
 * Owner partition for shared-wiki deployments.
 *
 * Byte-pinned: this string IS the HKDF derivation label, the `:ownerId` path
 * segment, the R2 key prefix, the Durable Object name prefix, and the local
 * IndexedDB key prefix for every shared-wiki server. Changing the bytes breaks
 * every existing shared-wiki deployment's data. Do not edit.
 *
 * Personal-mode deployments never read this; their owner partition is the
 * signed-in user's id.
 */
export const SHARED_OWNER_ID = asOwnerId('shared');

/**
 * Owner partition for the single-partition instance (self-host; ADR-0073).
 *
 * Byte-pinned, like {@link SHARED_OWNER_ID}: this string IS the `:ownerId` path
 * segment, the R2 key prefix, the Durable Object name prefix, and the local
 * IndexedDB key prefix for every instance deployment. Changing the bytes breaks
 * every existing instance's data. Do not edit.
 *
 * Pinned to a CONSTANT independent of caller identity (the `shared()` topology,
 * not `personal()` keyed by user id): every operator-supplied bearer resolves to
 * the same partition, so a future per-person named token adds identity without
 * re-partitioning the box's data. The hosted cloud never reads this; its owner
 * partition is the signed-in user's id (`personal()`).
 */
export const INSTANCE_OWNER_ID = asOwnerId('instance');
