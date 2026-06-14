/**
 * Provider and model configuration for Opensidian AI chat.
 *
 * Pure data: no Svelte runes, no side effects. The provider and model set is
 * the shared servable registry (`@epicenter/constants/ai-providers`), so the
 * picker can only offer what the `/api/ai` server validator accepts.
 */

import { SERVABLE_PROVIDER_MODELS } from '@epicenter/constants/ai-providers';

export const PROVIDER_MODELS = SERVABLE_PROVIDER_MODELS;

export type Provider = keyof typeof PROVIDER_MODELS;

export const DEFAULT_PROVIDER = 'openai' satisfies Provider;
export const DEFAULT_MODEL = PROVIDER_MODELS[DEFAULT_PROVIDER][0];
