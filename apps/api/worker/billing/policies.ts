/**
 * Cloud-only deployment policies that wrap `@epicenter/server` mount
 * primitives with Autumn-backed billing.
 *
 * Each policy is a thin shell around the billing service. The service owns
 * the Autumn round-trips and the AI reservation lock (the `lockId` never
 * leaves it); policies own only HTTP shape: pulling fields off the request,
 * forwarding the guard's typed error to `c.json`, and pushing after-response
 * settlement/sync work onto the queue from `@epicenter/server`. Those ops
 * return a `Result` (they never reject) and the adapter logs any provider
 * failure at its source, so a failed finalize or storage sync is recorded
 * rather than silently swallowed by the queue's `Promise.allSettled`, with no
 * separate settlement wrapper needed.
 *
 *   chargeOpenAiCreditsWithAutumn  Around `/v1/chat/completions` (the
 *                                  OpenAI-compatible gateway). Reserves credits
 *                                  (a lock) before the call, then confirms on
 *                                  success or releases on a pre-stream failure.
 *                                  The gateway is house-key-only, so every call
 *                                  is metered (ADR-0054): no BYOK bypass.
 *
 * AI reservations use Autumn's lock + `balances.finalize` rather than
 * deduct-then-refund: if the worker dies before finalizing, Autumn
 * auto-releases the hold at its TTL, so a failed request can never silently
 * overcharge. When the provider is unreachable the guard returns a structured
 * `BillingError` (fail closed), so the surface answers with a billing envelope
 * instead of a naked 500.
 *
 * The content-addressed blob store is unmetered in v1 (no storage policy here):
 * Autumn `check()` denies by default with no plan attached, so deferred quota
 * means not calling it. A `syncBlobStorageWithAutumn` policy slots in when blob
 * storage is billed (spec 20260623T220000, decision 10).
 *
 * The library remains billing-agnostic; everything here is cloud-only.
 */

import {
	type AiChatError,
	AiChatErrorStatus,
} from '@epicenter/constants/ai-chat-errors';
import type { Env } from '@epicenter/server';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { BillingError } from './errors.js';
import { createBillingService } from './service.js';

function billingFor(c: Context<Env>) {
	// Billing is cloud-only: `AUTUMN_SECRET_KEY` lives on this deployment's own
	// `Cloudflare.Env`, not the library's portable `ServerBindings` (ADR-0065),
	// so read it through the same edge cast the runtime-port resolvers use.
	return createBillingService(c.env as Cloudflare.Env, {
		userId: c.var.user.id,
		userEmail: c.var.user.email,
	});
}

/**
 * Around `/v1/chat/completions` (the OpenAI-compatible gateway, the only metered
 * inference path). A fixed-per-model reservation: reserve a credit lock before
 * the call, confirm on success or release on a pre-stream failure (>= 400). Once
 * the SSE stream starts the status is already 200, so a mid-stream provider
 * failure commits by design (those provider tokens were consumed and are
 * non-refundable); a failed finalize is logged at the adapter and self-heals via
 * the lock TTL. The model is read from the OpenAI body shape (top-level `model`)
 * and a guard failure answers in the OpenAI error shape
 * (`{ error: { message, code } }`) so the client engine keeps its branchable
 * `error.code`. The gateway is house-key-only (ADR-0054), so every call is
 * metered; there is no BYOK bypass.
 */
export const chargeOpenAiCreditsWithAutumn = createMiddleware<Env>(
	async (c, next) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			model?: string;
		};

		const billing = billingFor(c);
		const { data: reservation, error: guardError } =
			await billing.reserveAiChat({ model: body.model ?? '' });
		if (guardError) {
			return c.json(toOpenAiError(guardError), aiGuardStatus(guardError));
		}

		await next();

		c.var.afterResponseQueue.push(
			c.res.status >= 400 ? reservation.release() : reservation.confirm(),
		);
	},
);

/**
 * Render a guard failure as the OpenAI error envelope. The variant `name`
 * (`InsufficientCredits`, `ModelRequiresPaidPlan`, ...) becomes `error.code`, so
 * the client reducer can branch on a stable code rather than a message string.
 */
function toOpenAiError(error: AiChatError | BillingError): {
	error: { message: string; code: string };
} {
	return { error: { message: error.message, code: error.name } };
}

/**
 * Resolve the HTTP status for an AI guard failure. A `BillingError` means the
 * provider call failed and we fail closed, so it answers with a fixed 503
 * (entitlement unverifiable -> service unavailable); the actionable
 * `AiChatError` variants map through the sibling status table. 503 is a trusted
 * literal, so no cast on an untrusted provider value.
 */
function aiGuardStatus(
	error: AiChatError | BillingError,
): ContentfulStatusCode {
	if (error.name === 'ProviderRequestFailed') return 503;
	return AiChatErrorStatus[error.name];
}
