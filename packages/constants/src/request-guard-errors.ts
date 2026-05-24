import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for pre-handler 403 boundary refusals.
 *
 * Emitted by request-guard middleware in `@epicenter/server` before any
 * route handler runs. Both variants are co-located because they share a
 * domain: the request was rejected at an authorization or CSRF boundary,
 * not by the resource handler itself.
 *
 * Defined once in the shared constants package so server runtime and
 * any client SDK reference the same discriminated union. The server
 * calls the factories at runtime (`RequestGuardError.OwnerMismatch()`);
 * clients import the type via `InferErrors` for zero-cost narrowing.
 *
 * The serialized envelope is `wellcrafted`'s `{ data: null, error: {
 * name, message, ...fields } }`. Receivers branch on `body.error.name`.
 *
 * @example
 * ```ts
 * // Server: runtime usage
 * import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
 * return c.json(RequestGuardError.OwnerMismatch(), 403);
 *
 * // Client: type-only narrowing
 * import type { RequestGuardError } from '@epicenter/constants/request-guard-errors';
 * function handle(error: RequestGuardError) {
 *   switch (error.name) {
 *     case 'OwnerMismatch':    // wrong URL for this signed-in user
 *     case 'ForbiddenOrigin':  // CSRF: origin missing or not trusted
 *   }
 * }
 * ```
 */
export const RequestGuardError = defineErrors({
	OwnerMismatch: () => ({
		message: 'The request URL owner does not match the authenticated user.',
	}),
	ForbiddenOrigin: () => ({
		message: 'Origin header is missing or not in the trusted-origin allowlist.',
	}),
});

/**
 * Discriminated union of all request-guard error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type RequestGuardError = InferErrors<typeof RequestGuardError>;
