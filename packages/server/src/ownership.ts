/**
 * Ownership rule: how a request maps to an owner partition.
 *
 * The deployment composes one of these and threads it into every library
 * surface that needs the partition (`createRequireOwnership`, `mountRoomsApp`,
 * `mountBlobsApp`, `mountSessionApp`). They are constructed via {@link personal} /
 * {@link shared} / {@link instance} so call sites never type the discriminator
 * string. See `docs/articles/use-functions-to-wrap-discriminated-unions.md`.
 *
 *   personal: every authenticated user owns their own partition (the
 *             partition IS the user's id). No extra check beyond auth.
 *   shared:   every authenticated user shares the literal SHARED_OWNER_ID
 *             partition, gated by the deployment-provided `admit`
 *             predicate. Rejected users get 403 NotAdmitted at the
 *             boundary.
 *   instance: the shared topology as a preset (self-host; ADR-0073), pinning
 *             INSTANCE_OWNER_ID with an admit-always predicate; the operator
 *             bearer is the gate, so there is nobody to reject.
 *
 * The admit predicate runs per request (no caching). For email-domain
 * checks this is free; for DB-backed predicates it is one indexed query.
 * Per-request evaluation keeps access reflecting current state instead
 * of a stale at-sign-up decision.
 */

import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import {
	asOwnerId,
	INSTANCE_OWNER_ID,
	type OwnerId,
	SHARED_OWNER_ID,
} from '@epicenter/identity';
import type { Context } from 'hono';
import { Ok, type Result } from 'wellcrafted/result';
import type { Env } from './types.js';

/** Per-request admission predicate. Returns `true` to admit the user. */
export type Admit = (c: Context<Env>) => Promise<boolean> | boolean;

/**
 * Discriminated union of every ownership shape this library knows how to
 * compose. Constructed via {@link personal}, {@link shared}, or {@link instance};
 * consumed by {@link resolveOwnerPartition} and any sub-app that mounts
 * ownership-scoped routes.
 *
 * There are exactly TWO topologies, not three (ADR-0070): `personal` derives the
 * partition per identity, and the pin-to-constant `shared` kind pins it to a byte-
 * constant gated by `admit`. {@link instance} is NOT a third kind: it is the
 * `shared` topology as a preset, pinning a DIFFERENT constant (`INSTANCE_OWNER_ID`)
 * with an admit-always predicate, because the operator bearer is the gate
 * (ADR-0073). The constant the kind pins to therefore rides on the rule.
 */
export type OwnershipRule =
	| { kind: 'personal' }
	| { kind: 'shared'; admit: Admit; ownerId: OwnerId };

/** Construct the personal-mode ownership rule. */
export const personal = (): OwnershipRule => ({ kind: 'personal' });

/**
 * Construct the shared-mode ownership rule with an admission predicate. Pins the
 * partition to the byte-constant {@link SHARED_OWNER_ID}.
 */
export const shared = (opts: { admit: Admit }): OwnershipRule => ({
	kind: 'shared',
	admit: opts.admit,
	ownerId: SHARED_OWNER_ID,
});

/**
 * Construct the single-partition instance ownership rule (self-host; ADR-0073).
 *
 * The pin-to-constant topology `shared()` already implements, exposed as a preset:
 * the partition is pinned to {@link INSTANCE_OWNER_ID} and `admit` always passes,
 * because authentication is the operator-supplied bearer, not a per-user
 * predicate. It is decoupled from caller identity by construction: every valid
 * bearer maps to the SAME `owners/instance`, so adding per-person named tokens
 * later adds identity without re-partitioning the box's data. NOT `personal()`
 * keyed by a fixed id (that would shatter into `owners/<id>` the day a second
 * token is added), and NOT a new `OwnershipRule.kind`.
 */
export const instance = (): OwnershipRule => ({
	kind: 'shared',
	admit: () => true,
	ownerId: INSTANCE_OWNER_ID,
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
 * Shared:   runs the predicate; admits with the rule's pinned `ownerId`
 *           (`SHARED_OWNER_ID` for a shared wiki, `INSTANCE_OWNER_ID` for an
 *           instance whose `admit` always passes) or rejects with `NotAdmitted`.
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
			return Ok(rule.ownerId);
		}
	}
}
