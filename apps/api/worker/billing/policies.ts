/**
 * Cloud-only deployment policies that wrap `@epicenter/server` mount
 * primitives with Autumn-backed billing.
 *
 * Each policy is a thin shell around the billing service. The service owns
 * the Autumn round-trips and the reservation lock (the `lockId` never leaves
 * it); policies own only HTTP shape: pulling fields off the request, forwarding
 * the guard's typed error to `c.json`, and pushing the reservation's
 * `confirm`/`release` (or a delete credit) onto the after-response queue from
 * `@epicenter/server`. Those settlement ops return a `Result` (they never
 * reject) and the adapter logs any provider failure at its source, so a failed
 * finalize is recorded rather than silently swallowed by the queue's
 * `Promise.allSettled`, with no separate settlement wrapper needed.
 *
 *   chargeAiCreditsWithAutumn      Around `/api/ai/chat`. Reserves credits
 *                                  (a lock) before the call, then confirms on
 *                                  success or releases on a pre-stream failure.
 *                                  BYOK callers bypass billing entirely.
 *   trackAssetStorageWithAutumn    Around `/api/.../assets`. Reserves storage
 *                                  on POST uploads (a lock), confirms on 201
 *                                  and releases otherwise, and credits bytes
 *                                  back on 204 DELETE (size carried via header).
 *
 * Reservations use Autumn's lock + `balances.finalize` rather than
 * deduct-then-refund: if the worker dies before finalizing, Autumn
 * auto-releases the hold at its TTL, so a failed request can never silently
 * overcharge. When the provider is unreachable the guard returns a structured
 * `BillingError` (fail closed), so these surfaces answer with a billing
 * envelope instead of a naked 500.
 *
 * The library remains billing-agnostic; everything here is cloud-only.
 */

import {
	type AiChatError,
	AiChatErrorStatus,
} from '@epicenter/constants/ai-chat-errors';
import type { AssetError } from '@epicenter/constants/asset-errors';
import type { Env } from '@epicenter/server';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { BillingError } from './errors.js';
import { createBillingService } from './service.js';

type AiChatBody = {
	data?: { model?: string; provider?: string };
	apiKey?: string;
};

/**
 * Resolve the HTTP status for an AI guard failure. A `BillingError` means the
 * provider call failed and we fail closed, so it answers with a fixed 503
 * (entitlement unverifiable -> service unavailable); the actionable
 * `AiChatError` variants map through the sibling status table. 503 is a trusted
 * literal, so no cast on an untrusted provider value.
 */
function aiGuardStatus(error: AiChatError | BillingError): ContentfulStatusCode {
	if (error.name === 'ProviderRequestFailed') return 503;
	return AiChatErrorStatus[error.name];
}

/**
 * Resolve the HTTP status for a storage guard failure. A `BillingError` is a
 * fail-closed provider failure (fixed 503); every `AssetError` variant bakes in
 * its own `status`.
 */
function storageGuardStatus(
	error: AssetError | BillingError,
): ContentfulStatusCode {
	if (error.name === 'ProviderRequestFailed') return 503;
	return error.status;
}

export const chargeAiCreditsWithAutumn = createMiddleware<Env>(
	async (c, next) => {
		const body = (await c.req.json().catch(() => ({}))) as AiChatBody;

		// BYOK: caller-provided key bypasses billing. The library handler reads
		// the same body and prefers the caller key, so no credits are consumed.
		if (body.apiKey) {
			return next();
		}

		const billing = createBillingService(c.env, {
			userId: c.var.user.id,
			userEmail: c.var.user.email,
		});

		const { data: reservation, error: guardError } = await billing.reserveAiChat(
			{
				model: body.data?.model ?? '',
				provider: body.data?.provider,
			},
		);
		if (guardError) {
			return c.json({ data: null, error: guardError }, aiGuardStatus(guardError));
		}

		await next();

		// Commit the reserved credits on success; release them on a pre-stream
		// failure (>= 400) where no work was done. Once the SSE stream starts the
		// status is already 200, so a mid-stream provider failure commits by
		// design: those provider tokens were consumed and are non-refundable. A
		// failed finalize is logged at the adapter and self-heals via the lock
		// TTL, so the policy just keeps the op on the after-response queue.
		c.var.afterResponse.push(
			c.res.status >= 400 ? reservation.release() : reservation.confirm(),
		);
	},
);

export const trackAssetStorageWithAutumn = createMiddleware<Env>(
	async (c, next) => {
		const method = c.req.method;

		if (method === 'POST') {
			const parsed = await c.req.parseBody({ all: false }).catch(() => null);
			const file = parsed?.file;
			if (!(file instanceof File)) {
				// Library will return 400 for missing-file; nothing to reserve.
				return next();
			}

			const billing = createBillingService(c.env, {
				userId: c.var.user.id,
				userEmail: c.var.user.email,
			});
			const { data: reservation, error: guardError } =
				await billing.reserveAssetStorage({ sizeBytes: file.size });
			if (guardError) {
				return c.json(
					{ data: null, error: guardError },
					storageGuardStatus(guardError),
				);
			}

			await next();

			// Commit the reservation on a successful upload (201); release it
			// otherwise so a failed upload does not hold quota until the lock TTL.
			// A failed finalize is logged at the adapter and self-heals via the TTL.
			c.var.afterResponse.push(
				c.res.status === 201 ? reservation.confirm() : reservation.release(),
			);
			return;
		}

		if (method === 'DELETE') {
			await next();
			if (c.res.status !== 204) return;
			const sizeHeader = c.res.headers.get('x-deleted-size-bytes');
			const size = sizeHeader ? Number.parseInt(sizeHeader, 10) : null;
			if (size == null || Number.isNaN(size)) return;
			const billing = createBillingService(c.env, {
				userId: c.var.user.id,
				userEmail: c.var.user.email,
			});
			// A delete credit has no lock to expire, so a failure leaves quota
			// consumed permanently. The adapter logs it; durable recovery (an
			// idempotency-keyed retry plus a storage reconciliation sweep) is a
			// tracked follow-up, since storage bytes are recomputable.
			c.var.afterResponse.push(billing.creditAssetStorage(size));
			return;
		}

		// GET, OPTIONS, etc. pass through.
		return next();
	},
);
