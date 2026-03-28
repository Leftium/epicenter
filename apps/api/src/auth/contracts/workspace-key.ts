/**
 * Portable contract for the `GET /workspace-key` response.
 *
 * The workspace-key endpoint derives a per-user encryption key and returns it
 * alongside the current key version. Clients call this once after sign-in and
 * again whenever the session's `keyVersion` differs from the locally cached one.
 *
 * This file is intentionally runtime-free so both server and client packages
 * can import the contract without pulling in Cloudflare Workers or crypto deps.
 */

/** Response shape from `GET /workspace-key`. */
export type WorkspaceKeyResponse = {
	userKeyBase64: string;
	keyVersion: number;
};
