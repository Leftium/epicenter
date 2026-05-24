/**
 * Server-side helper that converts the static `MODEL_CREDITS` table
 * plus `providerOf` into the wire DTO the dashboard renders.
 *
 * The dashboard could equally well import the catalog at build time,
 * but going through the API surface lets us add filtering, hide
 * deprecated models, or annotate rows server-side later without
 * changing the dashboard contract.
 */

import {
	MODEL_CREDITS,
	providerOf,
} from '@epicenter/billing/ai-model-pricing';
import type { ModelCostGuide } from '@epicenter/billing/contracts';

export function getModelCostGuide(): ModelCostGuide {
	const models = Object.entries(MODEL_CREDITS)
		.filter((entry): entry is [string, number] => entry[1] !== undefined)
		.map(([model, credits]) => ({
			model,
			provider: providerOf(model),
			credits,
		}))
		.sort(
			(a, b) => a.credits - b.credits || a.model.localeCompare(b.model),
		);
	return { models };
}
