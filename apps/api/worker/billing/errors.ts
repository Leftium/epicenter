import { type } from 'arktype';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variant for a failed call to the billing provider.
 *
 * A `BillingError` means one thing: the call to our billing provider
 * (Autumn) failed, so we fail closed. It is deliberately opaque, a
 * single human-readable `message`. It carries neither the provider's
 * HTTP status nor Autumn's machine `code`, because there is no
 * user-actionable sub-state to branch on: whether Autumn returned a 502,
 * a 503, or a socket timeout, the only honest response is "billing is
 * temporarily unavailable, try again," and surfacing the vendor's code
 * would leak provider internals into the wire format.
 *
 * The actionable billing states (out of credits, model needs a paid
 * plan, storage quota exceeded) are NOT `BillingError`. They are typed
 * domain variants on the surface that raises them
 * (`AiChatError.InsufficientCredits`, `AiChatError.ModelRequiresPaidPlan`,
 * `AssetError.StorageLimitExceeded`), each with its own HTTP status. The
 * dashboard/clients branch on those for conversion UX; a `BillingError`
 * is always rendered as a single opaque message.
 *
 * The `ProviderRequestFailed` name avoids leaking the vendor: a future
 * swap to direct Stripe integration would not force a client rename.
 *
 * @example
 * ```ts
 * // Server: the billing-routes onError boundary maps any thrown Autumn
 * // failure through the adapter; non-provider throws rethrow to a 500.
 * import { isAutumnError, mapAutumnError } from './autumn.js';
 *
 * billingRoutes.onError((err, c) => {
 *   if (!isAutumnError(err)) throw err;
 *   return c.json(mapAutumnError(err), 503);
 * });
 *
 * // Client: type-only narrowing (from apps/api/ui via $api alias)
 * import type { BillingError } from '$api/billing/errors';
 * function handle(error: BillingError) {
 *   // one opaque message; render it, optionally offer retry
 *   showBillingUnavailable(error.message);
 * }
 * ```
 */
export const BillingError = defineErrors({
	ProviderRequestFailed: ({ message }: { message: string }) => ({
		message,
	}),
});

/**
 * Discriminated union of all billing error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type BillingError = InferErrors<typeof BillingError>;

/**
 * Runtime schema for the serialized `BillingError` envelope on the wire.
 *
 * `c.json(BillingError.ProviderRequestFailed(...))` serializes the wellcrafted
 * `Err` shape `{ data: null, error: { name, message } }`. The dashboard
 * receives that across an untrusted network boundary, so it validates against
 * this schema before trusting the body as a `BillingError` rather than
 * duck-checking a single `name` key. Undeclared keys are ignored, so the server
 * can add fields without breaking older clients.
 *
 * This schema and the `defineErrors` factory above are two representations of
 * one contract; their agreement is pinned by `errors.test.ts`.
 */
export const BillingErrorEnvelope = type({
	data: 'null',
	error: {
		name: "'ProviderRequestFailed'",
		message: 'string',
	},
});
