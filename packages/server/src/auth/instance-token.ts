/**
 * The single-partition instance's bearer credential (self-host; ADR-0073).
 *
 * A self-hosted instance authenticates one operator-supplied static bearer
 * (`INSTANCE_TOKEN`). The operator generates it once (`gen-token`, backed by
 * `generateInstanceToken` in `@epicenter/auth`), supplies it through the
 * environment, and pastes it into the client's instance setting
 * (`{ baseURL, token }`, ADR-0071). Every request then arrives as
 * `Authorization: Bearer <token>`, and {@link createInstanceTokenResolver} is the
 * `ResolveUser` the deployment injects on `createServerApp` to turn that bearer
 * into the instance's principal.
 *
 * This is the VERIFIER side of that credential: it needs `AuthUser`/`ResolveUser`,
 * so it lives in `@epicenter/server`. The pure pieces that need neither (the token
 * generator and the boot entropy gate, `generateInstanceToken` /
 * `assertStrongToken`) live in `@epicenter/auth` so a token can be minted and
 * validated without the server graph.
 *
 * It is a credential SOURCE, not a new auth mode: it feeds the one total gate
 * exactly like `resolveRequestOAuthUser`, and it pairs with `instance()` (the
 * pin-to-constant `owners/instance` partition), so the 401 gate, the partition
 * switch, and every owner-scoped route never learn that "self-host" exists. There
 * is no OAuth on an instance; OAuth stays the hosted star's only (ADR-0071).
 *
 * The check is VERIFIER-shaped on purpose. `verify(presented) -> principal | null`
 * is the seam: v1 compares one env token ({@link verifyEnvToken}); a future
 * multi-person instance swaps the body for a hashed-registry lookup that returns a
 * NAMED principal (alice, bob) against the SAME constant partition, so per-token
 * identity and authenticated attribution become a body-swap, never a rewrite or a
 * data migration. That registry is a documented, deliberately-unbuilt seam
 * (ADR-0073): v1 ships the shape, not the feature.
 *
 * Portable (ADR-0066): nothing here names `node:` or touches disk. The constant-
 * time compare and the token generator both use the Web Crypto `crypto` global,
 * which Bun and Cloudflare Workers expose identically, so the instance runs on
 * either runtime with the operator supplying the secret.
 */

import { AuthUser, asUserId } from '@epicenter/auth';
import { OAuthError } from '@epicenter/constants/oauth-errors';
import { Ok } from 'wellcrafted/result';
import type { ResolveUser } from '../types.js';
import { parseBearer } from './parse-bearer.js';

/**
 * The instance's single principal: a NAMED `AuthUser`, not a boolean. Returned by
 * the v1 verifier for any valid bearer. Its `id` is decoupled from the partition
 * (`owners/instance` is pinned by `instance()` regardless of caller identity), so
 * this value is purely the authenticated identity stamped onto `c.var.user` and
 * presence frames, never the partition key. When the named-token registry seam is
 * built, the verifier returns per-token principals here instead; the partition
 * stays constant.
 */
export const INSTANCE_PRINCIPAL: AuthUser = AuthUser.assert({
	id: asUserId('instance-owner'),
	email: 'owner@instance.local',
});

/**
 * The instance bearer verifier seam: map a presented bearer to the principal it
 * authenticates as, or `null` if it authenticates nobody. v1's body is a single
 * constant-time compare ({@link verifyEnvToken}); the named-token registry swaps
 * it for a hashed lookup without touching {@link createInstanceTokenResolver} or
 * the constant partition (ADR-0073). Async because the constant-time compare is
 * (it awaits a Web Crypto digest), and a registry lookup would be too.
 */
export type VerifyToken = (presented: string) => Promise<AuthUser | null>;

/**
 * Constant-time equality for two strings of any length.
 *
 * Both sides are first hashed to a fixed 32-byte SHA-256 digest, so the compare
 * loop runs the same length regardless of the inputs (no early-out on the first
 * differing byte and no length tell), and an attacker observing comparison
 * timing learns nothing about the configured token: they would need a preimage
 * of its digest. `crypto.subtle` is a Web Crypto global on both Bun and Workers,
 * so this stays portable and names no `node:` built-in on the shared surface.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);
	const bytesA = new Uint8Array(digestA);
	const bytesB = new Uint8Array(digestB);
	let mismatch = 0;
	for (let i = 0; i < bytesA.length; i += 1) {
		mismatch |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
	}
	return mismatch === 0;
}

/**
 * The v1 verifier: a constant-time compare against the operator-supplied secret,
 * resolving any exact match to {@link INSTANCE_PRINCIPAL}. The whole secret lives
 * in this closure, so the seam stays `(presented) -> principal | null` and the
 * registry variant is a drop-in replacement.
 */
export const verifyEnvToken =
	(secret: string): VerifyToken =>
	async (presented) =>
		(await constantTimeEqual(presented, secret)) ? INSTANCE_PRINCIPAL : null;

/**
 * Build the `ResolveUser` for a token-authenticated instance from a verifier. A
 * request whose `Authorization: Bearer <token>` the verifier accepts resolves to
 * that principal; a missing, non-bearer, or rejected token is an `InvalidToken`,
 * the same `Result` arm the OAuth resolver returns, so the surface wrappers reject
 * it unchanged (HTTP 401 with the OAuth `WWW-Authenticate` challenge, or the rooms
 * 4401 close).
 */
export function createInstanceTokenResolver(verify: VerifyToken): ResolveUser {
	return async (c) => {
		const presented = parseBearer(c.req.header('authorization') ?? null);
		if (!presented) return OAuthError.InvalidToken();
		const principal = await verify(presented);
		return principal ? Ok(principal) : OAuthError.InvalidToken();
	};
}
