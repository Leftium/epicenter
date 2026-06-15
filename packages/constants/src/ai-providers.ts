/**
 * AI provider registry and model catalog for hosted chat.
 *
 * `AI_PROVIDERS` owns durable provider ids and labels for persisted billing
 * events. `AI_MODELS` owns the currently servable set: there are no hidden,
 * legacy, or compatibility models, and provider is never a user-facing choice.
 * A model id is always a member of the matching provider SDK's model union, so a
 * typo or a model the SDK cannot route is a compile error here rather than a
 * runtime 400.
 */
import type { GeminiTextModels } from '@tanstack/ai-gemini';
import type { OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';

type OpenAiModel = (typeof OPENAI_CHAT_MODELS)[number];
type GeminiModel = (typeof GeminiTextModels)[number];

/**
 * Durable provider ids and display names. Provider ids are persisted on billing
 * events, so this registry can outlive the currently servable model catalog.
 */
export const AI_PROVIDERS = {
	openai: { label: 'OpenAI' },
	gemini: { label: 'Google' },
} as const;

export type AiProvider = keyof typeof AI_PROVIDERS;

export function isAiProvider(value: string): value is AiProvider {
	return Object.hasOwn(AI_PROVIDERS, value);
}

const SERVABLE_PROVIDER_IDS = [
	'openai',
	'gemini',
] as const satisfies readonly AiProvider[];
type ServableProvider = (typeof SERVABLE_PROVIDER_IDS)[number];

type ModelIdByProvider = {
	openai: OpenAiModel;
	gemini: GeminiModel;
};

/**
 * One sellable model. `label` is the product role shown in the picker (Fast,
 * Best), not a vendor name. Discriminated on `provider` so that switching on it
 * narrows `id` to the matching SDK model union: a consumer routing to an
 * adapter gets the right id type with no cast, and a gemini id can never be
 * paired with `provider: 'openai'`.
 */
export type AiModel = {
	[P in ServableProvider]: {
		id: ModelIdByProvider[P];
		provider: P;
		label: string;
		credits: number;
	};
}[ServableProvider];

/**
 * The catalog, in display order. One credit = $0.01 at Pro overage
 * ($1 / 100 credits); prices hold margin against provider list prices for an
 * average chat call of 750 input and 1500 output tokens. `gemini-3.5-flash`
 * is the Chinese-tuned default for Zhongwen and is not offered elsewhere.
 */
export const AI_MODELS = [
	{ id: 'gpt-5.4-mini', provider: 'openai', label: 'Fast', credits: 2 },
	{ id: 'gpt-5.5', provider: 'openai', label: 'Best', credits: 10 },
	{ id: 'gemini-3.5-flash', provider: 'gemini', label: 'Fast', credits: 2 },
] as const satisfies readonly AiModel[];

export type ServableModel = (typeof AI_MODELS)[number]['id'];

/** Tuple of every servable model id, for arktype `type.enumerated(...)`. */
export const SERVABLE_MODELS = AI_MODELS.map((model) => model.id) as [
	ServableModel,
	...ServableModel[],
];

/** Catalog entry by id, for pickers that render label and credits. */
export const MODELS_BY_ID = Object.fromEntries(
	AI_MODELS.map((model) => [model.id, model]),
) as Record<ServableModel, AiModel>;
