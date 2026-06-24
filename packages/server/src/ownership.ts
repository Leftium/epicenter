/**
 * Ownership rule: how a request maps to an owner partition.
 *
 * The deployment composes one of two variants and threads it into every
 * library surface that needs the partition (`createRequireOwnership`,
 * `mountRoomsApp`, `mountBlobsApp`, `mountSessionApp`). The variants are
 * constructed via {@link personal} / {@link shared} so call sites never type
 * the discriminator string. See
 * `docs/articles/use-functions-to-wrap-discriminated-unions.md`.
 *
 *   personal: every authenticated user owns their own partition (the
 *             partition IS the user's id). No extra check beyond auth.
 *   shared:   every authenticated user shares the literal SHARED_OWNER_ID
 *             partition, gated by the deployment-provided `admit`
 *             predicate. Rejected users get 403 NotAdmitted at the
 *             boundary.
 *
 * The admit predicate runs per request (no caching). For email-domain
 * checks this is free; for DB-backed predicates it is one indexed query.
 * Per-request evaluation keeps access reflecting current state instead
 * of a stale at-sign-up decision.
 */

import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import { asOwnerId, type OwnerId, SHARED_OWNER_ID } from '@epicenter/identity';
import type { Context } from 'hono';
import { Ok, type Result } from 'wellcrafted/result';
import type { Env } from './types.js';

/** Per-request admission predicate. Returns `true` to admit the user. */
export type Admit = (c: Context<Env>) => Promise<boolean> | boolean;

/**
 * Discriminated union of every ownership shape this library knows how to
 * compose. Constructed via {@link personal} or {@link shared}; consumed by
 * {@link resolveOwnerPartition} and any sub-app that mounts ownership-
 * scoped routes.
 */
export type OwnershipRule =
	| { kind: 'personal' }
	| { kind: 'shared'; admit: Admit };

/** Construct the personal-mode ownership rule. */
export const personal = (): OwnershipRule => ({ kind: 'personal' });

/** Construct the shared-mode ownership rule with an admission predicate. */
export const shared = (opts: { admit: Admit }): OwnershipRule => ({
	kind: 'shared',
	admit: opts.admit,
});

/**
 * The single switch on `rule.kind` in the codebase. The `requireOwnership`
 * middleware delegates here, so the partition decision lives in one place.
 *
 * Returns the owner partition the request maps to. In shared mode this
 * function also AUTHORIZES the request: rejected users get an `Err` arm
 * carrying `NotAdmitted` before any URL is read. The caller decides
 * whether to compare the partition to a URL `:ownerId` segment (the
 * `requireOwnership` middleware does).
 *
 * Personal: always succeeds, returns the user's id branded as `OwnerId`.
 * Shared:   runs the predicate; admits with `SHARED_OWNER_ID` or rejects
 *           with `NotAdmitted`.
 */
export async function resolveOwnerPartition(
	rule: OwnershipRule,
	c: Context<Env>,
): Promise<Result<OwnerId, RequestGuardError>> {
	switch (rule.kind) {
		case 'personal':
			return Ok(asOwnerId(c.var.user.id));
		case 'shared': {
			const admitted = await rule.admit(c);
			if (!admitted) return RequestGuardError.NotAdmitted();
			return Ok(SHARED_OWNER_ID);
		}
	}
}
