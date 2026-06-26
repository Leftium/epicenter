import { complete, resolveConnection } from '@epicenter/client';
import { InstantString } from '@epicenter/field';
import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result } from 'wellcrafted/result';
import type { InferenceProviderId } from '$lib/constants/inference';
import { services } from '$lib/services';
import type { CompletionService } from '$lib/services/completion';
import type { DeviceConfigKey } from '$lib/state/device-config.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { transformationRuns } from '$lib/state/transformation-runs.svelte';
import { transformationHasWork } from '$lib/state/transformations.svelte';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';
import type {
	Replacement,
	Transformation,
	TransformationPrompt,
	TransformationRun,
} from '$lib/workspace';

/**
 * Per-provider config keys: which deviceConfig entry holds each provider's
 * credential and endpoint override. The SSOT the editor reads to warn about a
 * missing credential, and the runner reads to build a request. Exhaustive over
 * InferenceProviderId: adding a provider to INFERENCE is a compile error here
 * until its entry exists. `*ConfigKey` names follow the transcription registry
 * convention (deviceConfig, local, never synced; no sign-in to use your own key).
 */
const COMPLETION_CONFIG = {
	OpenAI: {
		apiKeyConfigKey: 'providers.openai.apiKey',
		endpointConfigKey: 'providers.openai.endpoint',
	},
	Groq: {
		apiKeyConfigKey: 'providers.groq.apiKey',
		endpointConfigKey: 'providers.groq.endpoint',
	},
	Anthropic: {
		apiKeyConfigKey: 'providers.anthropic.apiKey',
		endpointConfigKey: null,
	},
	Google: {
		apiKeyConfigKey: 'providers.google.apiKey',
		endpointConfigKey: null,
	},
	OpenRouter: {
		apiKeyConfigKey: 'providers.openrouter.apiKey',
		endpointConfigKey: null,
	},
	Custom: {
		apiKeyConfigKey: 'providers.custom.apiKey',
		endpointConfigKey: 'providers.custom.endpoint',
	},
} as const satisfies Record<
	InferenceProviderId,
	{
		apiKeyConfigKey: DeviceConfigKey;
		/** Device config key for the endpoint; null when not configurable. */
		endpointConfigKey: DeviceConfigKey | null;
	}
>;

/**
 * The bespoke (non-wire) completion providers, keyed by id. These keep their own
 * SDK clients because they do not speak the OpenAI chat wire: Anthropic requires
 * `max_tokens` and returns content blocks, Google takes one combined prompt and
 * uses `generateContent`. The same wire-vs-bespoke split as the transcription
 * collapse; ADR-0060 blesses the exception.
 */
const BESPOKE_COMPLETIONS = {
	Anthropic: services.completions.anthropic,
	Google: services.completions.google,
} satisfies Partial<Record<InferenceProviderId, CompletionService>>;

type BespokeCompletionProviderId = keyof typeof BESPOKE_COMPLETIONS;

function isBespokeCompletionProvider(
	provider: InferenceProviderId,
): provider is BespokeCompletionProviderId {
	return provider in BESPOKE_COMPLETIONS;
}

/**
 * The canonical OpenAI chat-wire base URL for each wire provider (OpenAI, Groq,
 * OpenRouter, Custom: everything that is not bespoke). The endpoint override, when
 * the provider has one, wins over this default. Custom has no default: its base IS
 * the user's endpoint, which is required. `satisfies Record<Exclude<...>, ...>`
 * ties this to the bespoke split, so a new wire provider must add a base here.
 */
const WIRE_DEFAULT_BASE_URLS = {
	OpenAI: 'https://api.openai.com/v1',
	Groq: 'https://api.groq.com/openai/v1',
	OpenRouter: 'https://openrouter.ai/api/v1',
	Custom: null,
} satisfies Record<
	Exclude<InferenceProviderId, BespokeCompletionProviderId>,
	string | null
>;

/**
 * The deviceConfig keys a provider reads. Exposed so the editor can warn when the
 * credential a transformation needs is missing, instead of failing only at run
 * time. These live in deviceConfig (local, never synced); no sign-in required to
 * use your own key.
 */
export function getProviderConfigKeys(provider: InferenceProviderId): {
	apiKeyConfigKey: DeviceConfigKey;
	endpointConfigKey: DeviceConfigKey | null;
} {
	const { apiKeyConfigKey, endpointConfigKey } = COMPLETION_CONFIG[provider];
	return { apiKeyConfigKey, endpointConfigKey };
}

export const TransformError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	Empty: ({ message }: { message: string }) => ({ message }),
	ReplacementFailed: ({ message }: { message: string }) => ({ message }),
	PromptFailed: ({ message }: { message: string }) => ({ message }),
});
export type TransformError = InferErrors<typeof TransformError>;

/**
 * Apply a list of deterministic find/replace pairs in order. Offline, no API
 * key. A bad regex fails the whole phase with the pattern in the message.
 */
function applyReplacements(
	input: string,
	replacements: Replacement[],
): Result<string, string> {
	let text = input;
	for (const { find, replace, useRegex } of replacements) {
		if (useRegex) {
			try {
				text = text.replace(new RegExp(find, 'g'), replace);
			} catch (error) {
				return Err(`Invalid regex pattern: ${extractErrorMessage(error)}`);
			}
		} else {
			text = text.replaceAll(find, replace);
		}
	}
	return Ok(text);
}

/**
 * Run the one optional AI phase: interpolate the templates with `{{input}}`,
 * then call the prompt's backend with its model. Keys, model names, and URLs are
 * pasted strings, so trim once here: a trailing space fails the request opaquely.
 *
 * The wire providers (OpenAI, Groq, OpenRouter, Custom) route through the shared
 * Connection-floor `complete()`; the bespoke ones (Anthropic, Google) keep their
 * own SDK clients. Same split as the transcription collapse.
 */
function runPrompt(
	input: string,
	prompt: TransformationPrompt,
): Promise<Result<string, { message: string }>> {
	const systemPrompt = interpolateTemplate(
		asTemplateString(prompt.systemPromptTemplate),
		{ input },
	);
	const userPrompt = interpolateTemplate(
		asTemplateString(prompt.userPromptTemplate),
		{ input },
	);

	const provider = prompt.inferenceProvider;
	const model = prompt.model.trim();
	const { apiKeyConfigKey, endpointConfigKey } = COMPLETION_CONFIG[provider];
	const apiKey = deviceConfig.get(apiKeyConfigKey).trim();

	if (isBespokeCompletionProvider(provider)) {
		return BESPOKE_COMPLETIONS[provider].complete({
			apiKey,
			model,
			systemPrompt,
			userPrompt,
		});
	}

	// A wire provider: resolve a Connection (the endpoint override beats the
	// canonical default; Custom's endpoint IS its base and is required), then one
	// POST through the shared client. No key just means no header.
	const override = endpointConfigKey
		? deviceConfig.get(endpointConfigKey).trim()
		: '';
	const baseUrl = override || WIRE_DEFAULT_BASE_URLS[provider];
	if (!baseUrl) {
		return Promise.resolve(
			TransformError.PromptFailed({
				message: `Set a base URL for the ${provider} provider in settings.`,
			}),
		);
	}
	return complete(resolveConnection({ baseUrl, apiKey: apiKey || undefined }), {
		model,
		systemPrompt,
		userPrompt,
	});
}

/**
 * The guard both entry points share: a run needs non-empty input and a
 * transformation with at least one phase (the runnable invariant). Returns the
 * matching error, or null when the run may proceed. `runTransformation` calls it
 * before any write so a run that can't legitimately start leaves no record.
 */
function checkRunnable(
	input: string,
	transformation: Transformation,
): Result<never, TransformError> | null {
	if (!input.trim()) {
		return TransformError.InvalidInput({
			message: 'Empty input. Please enter some text to transform',
		});
	}
	if (!transformationHasWork(transformation)) {
		return TransformError.Empty({
			message:
				'This transformation has nothing to run. Add a replacement or a prompt',
		});
	}
	return null;
}

/**
 * Execute a transformation's three phases against `input` and return the output:
 * deterministic `preReplacements`, then the optional `prompt`, then deterministic
 * `postReplacements`. Pure execution: no workspace writes, no persistence, no
 * toasts. Validates the runnable invariant up front so direct callers (the
 * candidate fan-out) get the same guards as a persisted run.
 */
export async function executeTransformation({
	input,
	transformation,
}: {
	input: string;
	transformation: Transformation;
}): Promise<Result<string, TransformError>> {
	const guard = checkRunnable(input, transformation);
	if (guard) return guard;

	const { preReplacements, prompt, postReplacements } = transformation;

	const preResult = applyReplacements(input, preReplacements);
	if (isErr(preResult)) {
		return TransformError.ReplacementFailed({ message: preResult.error });
	}
	let current = preResult.data;

	if (prompt) {
		const promptResult = await runPrompt(current, prompt);
		if (isErr(promptResult)) {
			return TransformError.PromptFailed({
				message: extractErrorMessage(promptResult.error),
			});
		}
		current = promptResult.data;
	}

	const postResult = applyReplacements(current, postReplacements);
	if (isErr(postResult)) {
		return TransformError.ReplacementFailed({ message: postResult.error });
	}
	return Ok(postResult.data);
}

/**
 * Run a transformation and persist its run record. Persists at kickoff (with
 * `result: null`) and again on the terminal outcome (including failure); liveness
 * is derived from `startedAt`, never stored. Execution is delegated to
 * `executeTransformation`; this wrapper owns only the persistence. The returned
 * Result is purely for caller control flow. No toasts, no notifications.
 */
export async function runTransformation({
	input,
	transformation,
	recordingId,
}: {
	input: string;
	transformation: Transformation;
	recordingId: string | null;
}): Promise<Result<string, TransformError>> {
	// Don't leave a run record for a run that can't legitimately start.
	const guard = checkRunnable(input, transformation);
	if (guard) return guard;

	const transformationRun = {
		id: nanoid(),
		transformationId: transformation.id,
		recordingId,
		input,
		startedAt: InstantString.now(),
		result: null,
	} satisfies TransformationRun;
	transformationRuns.set(transformationRun);

	// A thrown provider or execution error must still land as a failed terminal
	// result. Without this, a throw escapes past the persistence below and the
	// kickoff row stays stuck at `result: null`, so the run reads as forever
	// running. Normalize any throw into an Err the failure branch records.
	let result: Result<string, TransformError>;
	try {
		result = await executeTransformation({ input, transformation });
	} catch (error) {
		result = TransformError.PromptFailed({
			message: extractErrorMessage(error),
		});
	}

	if (isErr(result)) {
		transformationRuns.set({
			...transformationRun,
			result: {
				status: 'failed',
				completedAt: InstantString.now(),
				error: result.error.message,
			},
		} satisfies TransformationRun);
		return result;
	}

	transformationRuns.set({
		...transformationRun,
		result: {
			status: 'completed',
			completedAt: InstantString.now(),
			output: result.data,
		},
	} satisfies TransformationRun);
	return result;
}

/**
 * Persist a single completed ad-hoc run (`recordingId: null`). The commit-time
 * counterpart to `runTransformation`: instead of a kickoff row plus a terminal
 * write, an ad-hoc run owns nothing until it succeeds, so this writes exactly one
 * completed row, never a kickoff, failed, or interrupted one. Used by the picker
 * accept and the clipboard quick-run, both of which run via `executeTransformation`
 * (no writes) and commit only the chosen result. `startedAt` is when execution
 * began; the result is terminal, so no liveness is ever derived from it.
 */
export function persistCompletedRun({
	transformationId,
	input,
	output,
	startedAt,
}: {
	transformationId: string;
	input: string;
	output: string;
	startedAt: InstantString;
}): void {
	transformationRuns.set({
		id: nanoid(),
		transformationId,
		recordingId: null,
		input,
		startedAt,
		result: {
			status: 'completed',
			completedAt: InstantString.now(),
			output,
		},
	} satisfies TransformationRun);
}
