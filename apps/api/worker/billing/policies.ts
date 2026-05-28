/**
 * Cloud-only deployment policies that wrap `@epicenter/server` mount
 * primitives with Autumn-backed billing.
 *
 * Each policy is a thin shell around the billing service. The service owns
 * the Autumn round-trips and DTO mapping; policies own only HTTP shape:
 * generating a reservation lock id, pulling fields off the request,
 * forwarding the guard's typed error to `c.json`, and queueing the
 * confirm/release finalize onto the after-response queue from
 * `@epicenter/server`.
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
 * Resolve the HTTP status for an AI guard failure. `BillingError` carries its
 * own `statusCode` (the upstream provider status, or 503 when unreachable);
 * every `AiChatError` variant maps through the sibling status table.
 */
function aiGuardStatus(error: AiChatError | BillingError): ContentfulStatusCode {
	if (error.name === 'ProviderRequestFailed') {
		return error.statusCode as ContentfulStatusCode;
	}
	return AiChatErrorStatus[error.name];
}

/**
 * Resolve the HTTP status for a storage guard failure. `BillingError` carries
 * its own `statusCode`; every `AssetError` variant bakes in its `status`.
 */
function storageGuardStatus(
	error: AssetError | BillingError,
): ContentfulStatusCode {
	if (error.name === 'ProviderRequestFailed') {
		return error.statusCode as ContentfulStatusCode;
	}
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

		const lockId = crypto.randomUUID();
		const { error: guardError } = await billing.guardAiChat({
			model: body.data?.model ?? '',
			provider: body.data?.provider,
			lockId,
		});
		if (guardError) {
			return c.json({ data: null, error: guardError }, aiGuardStatus(guardError));
		}

		await next();

		// Commit the reserved credits on success; release them on a pre-stream
		// failure (>= 400) where no work was done. Once the SSE stream starts the
		// status is already 200, so a mid-stream provider failure commits by
		// design: those provider tokens were consumed and are non-refundable.
		const action = c.res.status >= 400 ? 'release' : 'confirm';
		c.var.afterResponse.push(billing.finalizeAiCharge(lockId, action));
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
			const lockId = crypto.randomUUID();
			const { error: guardError } = await billing.reserveAssetStorage({
				sizeBytes: file.size,
				lockId,
			});
			if (guardError) {
				return c.json(
					{ data: null, error: guardError },
					storageGuardStatus(guardError),
				);
			}

			await next();

			// Commit the reservation on a successful upload (201); release it
			// otherwise so a failed upload does not hold quota until the lock TTL.
			const action = c.res.status === 201 ? 'confirm' : 'release';
			c.var.afterResponse.push(billing.finalizeAssetStorage(lockId, action));
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
			c.var.afterResponse.push(billing.creditAssetStorage(size));
			return;
		}

		// GET, OPTIONS, etc. pass through.
		return next();
	},
);
