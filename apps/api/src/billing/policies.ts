/**
 * Cloud-only deployment policies that wrap `@epicenter/server` mount
 * primitives with Autumn-backed billing.
 *
 * Each policy is a thin shell around the billing service. The service
 * owns the Autumn round-trips and DTO mapping; policies own only HTTP
 * shape: pulling fields off the request, choosing a status, queueing
 * refunds onto the after-response promise queue from `@epicenter/server`.
 *
 *   chargeAiCreditsWithAutumn      Around `/api/ai/chat`. Resolves the
 *                                  model from the chat body, asks the
 *                                  service to atomically check + deduct
 *                                  credits, and queues a refund when the
 *                                  handler responds 4xx/5xx. BYOK
 *                                  callers bypass billing entirely.
 *   trackAssetStorageWithAutumn    Around `/api/.../assets`. Pre-flights
 *                                  POST uploads against storage balance,
 *                                  tracks usage on 201 responses,
 *                                  releases bytes on 204 DELETE
 *                                  responses (size carried via header).
 *
 * The library remains billing-agnostic; everything here is cloud-only.
 */

import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import type { Env } from '@epicenter/server';
import { createMiddleware } from 'hono/factory';
import { createBillingService } from './service.js';

type AiChatBody = {
	data?: { model?: string; provider?: string };
	apiKey?: string;
};

/**
 * Map a guard-emitted AiChatError to its HTTP status. Exhaustive over the
 * full union so a new variant trips a compile error; the guard itself only
 * emits UnknownModel, ModelRequiresPaidPlan, and InsufficientCredits today.
 */
function statusForAiChatError(
	error: AiChatError,
): 400 | 401 | 402 | 403 | 500 {
	switch (error.name) {
		case 'UnknownModel':
			return 400;
		case 'ModelRequiresPaidPlan':
			return 403;
		case 'InsufficientCredits':
			return 402;
		case 'Unauthorized':
			return 401;
		case 'ProviderNotConfigured':
			return 500;
		default:
			return error satisfies never;
	}
}

export const chargeAiCreditsWithAutumn = createMiddleware<Env>(
	async (c, next) => {
		const body = (await c.req.json().catch(() => ({}))) as AiChatBody;

		// BYOK: caller-provided key bypasses billing. The library handler
		// reads the same body and uses the caller key over the deployment
		// key, so no credits get consumed.
		if (body.apiKey) {
			return next();
		}

		const billing = createBillingService(c.env, {
			userId: c.var.user.id,
			userEmail: c.var.user.email,
		});

		const { data: guardAllow, error: guardError } = await billing.guardAiChat({
			model: body.data?.model ?? '',
			provider: body.data?.provider,
		});
		if (guardError) {
			return c.json(
				{ data: null, error: guardError },
				statusForAiChatError(guardError),
			);
		}

		await next();

		// Successful streams keep the deducted credits. Any 4xx/5xx refunds.
		if (c.res.status >= 400) {
			c.var.afterResponse.push(billing.refundAiCharge(guardAllow.credits));
		}
	},
);

export const trackAssetStorageWithAutumn = createMiddleware<Env>(
	async (c, next) => {
		const method = c.req.method;

		if (method === 'POST') {
			const parsed = await c.req.parseBody({ all: false }).catch(() => null);
			const file = parsed?.file;
			if (!(file instanceof File)) {
				// Library will return 400 for missing-file; nothing to charge.
				return next();
			}

			const billing = createBillingService(c.env, {
				userId: c.var.user.id,
				userEmail: c.var.user.email,
			});
			const { error: guardError } = await billing.guardAssetUpload(file.size);
			// guardAssetUpload only emits StorageLimitExceeded, which is 402.
			if (guardError) {
				return c.json({ data: null, error: guardError }, 402);
			}

			await next();

			if (c.res.status === 201) {
				c.var.afterResponse.push(billing.trackAssetUpload(file.size));
			}
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
			c.var.afterResponse.push(billing.releaseAssetStorage(size));
			return;
		}

		// GET, OPTIONS, etc. pass through.
		return next();
	},
);
