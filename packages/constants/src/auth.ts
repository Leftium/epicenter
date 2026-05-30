/**
 * The JWT signing algorithm Epicenter pins for `id_token` and access tokens.
 *
 * This is the one signing knob Epicenter owns. Better Auth owns the rest of the
 * mechanics: it generates the key pair, stores it in the `jwks` table, and
 * publishes the public JWK. We only pin the algorithm. Everything downstream of
 * it (`kty: 'EC'`, `crv: 'P-256'`, the key material) is a result of `jose`
 * generating an ES256 key, not config we supply. Better Auth's `keyPairConfig`
 * for ES256 accepts `alg` alone (its type is `{ alg: 'ES256'; crv?: never }`),
 * so there is nothing else here to pin.
 *
 * ES256 (P-256 ECDSA) is chosen over the `jose` and Better Auth default of
 * EdDSA (Ed25519) for the broadest verifier-library support across browser
 * `jose`, Tauri Rust crates, and mobile. EdDSA is cryptographically sound and
 * is now in FIPS 186-5, but ES256 stays the safer compatibility default until
 * every Epicenter verifier (browser, Tauri Rust, mobile) is confirmed to verify
 * EdDSA.
 *
 * Stale `jwks` rows (for example an Ed25519 key minted before ES256 was pinned)
 * are durable data, not a config problem. They are repaired outside the request
 * path with a one-time SQL delete; the signing path never filters the table.
 */
export const JWT_SIGNING_ALG = 'ES256' as const;
