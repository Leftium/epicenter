/**
 * Provider and model configuration for Zhongwen chat.
 *
 * The provider and model set is the shared servable registry
 * (`@epicenter/constants/ai-providers`), so the picker can only offer what the
 * `/api/ai/chat/doc` validator accepts.
 */

import { SERVABLE_PROVIDER_MODELS } from '@epicenter/constants/ai-providers';

export const PROVIDER_MODELS = SERVABLE_PROVIDER_MODELS;

export type Provider = keyof typeof PROVIDER_MODELS;

export const DEFAULT_PROVIDER = 'gemini' satisfies Provider;
type DefaultProviderModel =
	(typeof PROVIDER_MODELS)[typeof DEFAULT_PROVIDER][number];
export const DEFAULT_MODEL =
	'gemini-3.1-flash-lite-preview' satisfies DefaultProviderModel;
