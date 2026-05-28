/** Prefix for OAuth bearer tokens carried through WebSocket subprotocols. */
export const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';

/**
 * Single owner of the JWT signing policy for `id_token` and access tokens.
 *
 * ES256 (P-256 ECDSA) is pinned for the broadest verifier-library support
 * across browser `jose`, Tauri Rust crates, and mobile; the `jose` default
 * would be EdDSA (Ed25519). `alg` drives Better Auth's `keyPairConfig` (the key
 * it mints), and `{ kty, crv }` is the JWK shape a stored key must have to be
 * valid under that policy. Both live here together so the algorithm and its
 * required key shape can never drift apart.
 *
 * This module imports no Better Auth (or `pg`/drizzle) code on purpose: the
 * deploy-time JWKS cleanup reads the same policy without pulling the request
 * path's heavy module graph into a `pg`-bound script.
 */
export const JWT_SIGNING = {
	alg: 'ES256',
	kty: 'EC',
	crv: 'P-256',
} as const;
