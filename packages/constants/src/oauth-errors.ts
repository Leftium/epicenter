import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the OAuth resource boundary.
 *
 * Emitted by the bearer-token resolver and surfaced to clients via
 * `createOAuthUnauthorizedResourceResponse` in `@epicenter/server`:
 *   - HTTP: `c.json(error, 401)` with `WWW-Authenticate: Bearer error="invalid_token"`.
 *   - WebSocket: close code 4401 with the error JSON in the close reason.
 *
 * Defined once in the shared constants package so the server runtime and
 * any client SDK reference the same discriminated union. The server calls
 * the factory at runtime (`OAuthError.InvalidToken()`); clients import the
 * type via `InferErrors` for zero-cost narrowing.
 *
 * The serialized envelope is `wellcrafted`'s `{ data: null, error: {
 * name, message, ...fields } }`. Receivers branch on `body.error.name`.
 *
 * The variant carries its own HTTP `status` (401), so call sites just
 * forward the baked-in code to `c.json`. No external status mapper required.
 *
 * `ServerError` (503) is distinct from `InvalidToken`: it means the resource
 * server could not verify the token because the signing-key (JWKS) endpoint
 * was unreachable, not because the token is bad. Flattening that case into a
 * 401 would make clients discard and refresh a perfectly good token (and pause
 * network auth) over a transient server fault, so it gets its own retryable
 * status instead.
 *
 * @example
 * ```ts
 * // Server: runtime usage
 * import { OAuthError } from '@epicenter/constants/oauth-errors';
 * if (!accessToken) return OAuthError.InvalidToken();
 *
 * // Client: type-only narrowing
 * import type { OAuthError } from '@epicenter/constants/oauth-errors';
 * function handle(error: OAuthError) {
 *   switch (error.name) {
 *     case 'InvalidToken':  // missing, malformed, unverifiable, or user-not-found
 *     case 'ServerError':   // token unverifiable due to a server-side fault
 *   }
 * }
 * ```
 */
export const OAuthError = defineErrors({
	InvalidToken: () => ({
		message: 'OAuth access token is missing, malformed, or unverifiable.',
		status: 401 as const,
	}),
	ServerError: () => ({
		message: 'OAuth token verification is temporarily unavailable.',
		status: 503 as const,
	}),
});

/**
 * Discriminated union of all OAuth resource-boundary error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type OAuthError = InferErrors<typeof OAuthError>;
