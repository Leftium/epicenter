/**
 * Custom fields added to getSession() responses by the `customSession` plugin.
 *
 * The server derives a per-user encryption key via HKDF and returns it
 * alongside the standard session/user data. These fields appear at the top
 * level of the getSession() response—signIn/signUp responses don't include them.
 *
 * This file is the source of truth for the contract between the API's
 * customSession callback and any client that reads these fields. It has
 * zero imports so clients can `import type` without pulling in Cloudflare
 * Workers types, drizzle, pg, or any other server dependency.
 *
 * @see {@link file://./app.ts} `createAuth` → `plugins` → `customSession()` (line ~156) — producer
 * @see {@link file://./app.ts} `deriveUserKey()` — HKDF key derivation
 */
export type CustomSessionFields = {
	encryptionKey: string;
	keyVersion: number;
};
