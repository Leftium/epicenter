import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result } from 'wellcrafted/result';
import type { InferenceProviderId } from '$lib/constants/inference';
import { services } from '$lib/services';
import type { DeviceConfigKey } from '$lib/state/device-config.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { transformationRuns } from '$lib/state/transformation-runs.svelte';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';
import type {
	Replacement,
	Transformation,
	TransformationPrompt,
	TransformationRun,
} from '$lib/workspace';

/**
 * Config map for completion providers, all sharing the
 * `{ apiKey, model, baseUrl?, systemPrompt, userPrompt }` call signature.
 * Exhaustive over InferenceProviderId: adding a provider to INFERENCE is a
 * compile error here until its entry exists. The custom service owns the
 * "endpoint is required" invariant via its validateParams. `*ConfigKey`
 * fields hold deviceConfig key names, same convention as the transcription
 * registry in `services/transcription/providers.ts`.
 */
const COMPLETION_PROVIDERS = {
	OpenAI: {
		service: services.completions.openai,
		apiKeyConfigKey: 'providers.openai.apiKey',
		endpointConfigKey: 'providers.openai.endpoint',
	},
	Groq: {
		service: services.completions.groq,
		apiKeyConfigKey: 'providers.groq.apiKey',
		endpointConfigKey: 'providers.groq.endpoint',
	},
	Anthropic: {
		service: services.completions.anthropic,
		apiKeyConfigKey: 'providers.anthropic.apiKey',
		endpointConfigKey: null,
	},
	Google: {
		service: services.completions.google,
		apiKeyConfigKey: 'providers.google.apiKey',
		endpointConfigKey: null,
	},
	OpenRouter: {
		service: services.completions.openrouter,
		apiKeyConfigKey: 'providers.openrouter.apiKey',
		endpointConfigKey: null,
	},
	Custom: {
		service: services.completions.custom,
		apiKeyConfigKey: 'providers.custom.apiKey',
		endpointConfigKey: 'providers.custom.endpoint',
	},
} as const satisfies Record<
	InferenceProviderId,
	{
		service: {
			complete: (opts: {
				apiKey: string;
				model: string;
				systemPrompt: string;
				userPrompt: string;
				baseUrl?: string;
			}) => Promise<Result<string, { message: string }>>;
		};
		apiKeyConfigKey: DeviceConfigKey;
		/** Device config key for the endpoint; null when not configurable. */
		endpointConfigKey: DeviceConfigKey | null;
	}
>;

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

	const config = COMPLETION_PROVIDERS[prompt.inferenceProvider];

	return config.service.complete({
		apiKey: deviceConfig.get(config.apiKeyConfigKey).trim(),
		model: prompt.model.trim(),
		baseUrl: config.endpointConfigKey
			? deviceConfig.get(config.endpointConfigKey).trim() || undefined
			: undefined,
		systemPrompt,
		userPrompt,
	});
}

/**
 * Run a transformation: deterministic `preReplacements`, then the optional
 * `prompt`, then deterministic `postReplacements`. Persists the run record to
 * workspace state at kickoff (with `result: null`) and again on the terminal
 * outcome (including failure); liveness is derived from `startedAt`, never
 * stored. The returned Result is purely for caller control flow. Pure
 * orchestration; no toasts, no notifications.
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
	if (!input.trim()) {
		return TransformError.InvalidInput({
			message: 'Empty input. Please enter some text to transform',
		});
	}

	const { preReplacements, prompt, postReplacements } = transformation;

	const hasWork =
		preReplacements.length > 0 || prompt !== null || postReplacements.length > 0;
	if (!hasWork) {
		return TransformError.Empty({
			message:
				'This transformation has nothing to run. Add a replacement or a prompt',
		});
	}

	const now = new Date().toISOString();
	const runId = nanoid();

	const transformationRun = {
		id: runId,
		transformationId: transformation.id,
		recordingId,
		input,
		startedAt: now,
		result: null,
	} satisfies TransformationRun;

	transformationRuns.set(transformationRun);

	const fail = (message: string) => {
		transformationRuns.set({
			...transformationRun,
			result: {
				status: 'failed',
				completedAt: new Date().toISOString(),
				error: message,
			},
		} satisfies TransformationRun);
	};

	const preResult = applyReplacements(input, preReplacements);
	if (isErr(preResult)) {
		fail(preResult.error);
		return TransformError.ReplacementFailed({ message: preResult.error });
	}
	let current = preResult.data;

	if (prompt) {
		const promptResult = await runPrompt(current, prompt);
		if (isErr(promptResult)) {
			const message = extractErrorMessage(promptResult.error);
			fail(message);
			return TransformError.PromptFailed({ message });
		}
		current = promptResult.data;
	}

	const postResult = applyReplacements(current, postReplacements);
	if (isErr(postResult)) {
		fail(postResult.error);
		return TransformError.ReplacementFailed({ message: postResult.error });
	}
	current = postResult.data;

	transformationRuns.set({
		...transformationRun,
		result: {
			status: 'completed',
			completedAt: new Date().toISOString(),
			output: current,
		},
	} satisfies TransformationRun);
	return Ok(current);
}
