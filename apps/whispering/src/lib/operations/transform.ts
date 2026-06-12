import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result } from 'wellcrafted/result';
import { INFERENCE, type InferenceProviderId } from '$lib/constants/inference';
import { services } from '$lib/services';
import type { DeviceConfigKey } from '$lib/state/device-config.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { transformationRuns } from '$lib/state/transformation-runs.svelte';
import { transformationStepRuns } from '$lib/state/transformation-step-runs.svelte';
import { transformationSteps } from '$lib/state/transformation-steps.svelte';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';
import type {
	Transformation,
	TransformationRun,
	TransformationStep,
	TransformationStepRun,
} from '$lib/workspace';

/**
 * Config map for completion providers, all sharing the
 * `{ apiKey, model, baseUrl?, systemPrompt, userPrompt }` call signature.
 * Exhaustive over InferenceProviderId: adding a provider to INFERENCE is a
 * compile error here until its entry exists. The custom service owns the
 * "endpoint is required" invariant via its validateParams.
 */
const COMPLETION_PROVIDERS = {
	OpenAI: {
		service: services.completions.openai,
		apiKeyKey: 'providers.openai.apiKey',
		endpointKey: 'providers.openai.endpoint',
	},
	Groq: {
		service: services.completions.groq,
		apiKeyKey: 'providers.groq.apiKey',
		endpointKey: 'providers.groq.endpoint',
	},
	Anthropic: {
		service: services.completions.anthropic,
		apiKeyKey: 'providers.anthropic.apiKey',
		endpointKey: null,
	},
	Google: {
		service: services.completions.google,
		apiKeyKey: 'providers.google.apiKey',
		endpointKey: null,
	},
	OpenRouter: {
		service: services.completions.openrouter,
		apiKeyKey: 'providers.openrouter.apiKey',
		endpointKey: null,
	},
	Custom: {
		service: services.completions.custom,
		apiKeyKey: 'providers.custom.apiKey',
		endpointKey: 'providers.custom.endpoint',
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
		apiKeyKey: DeviceConfigKey;
		/** Device config key for the endpoint; null when not configurable. */
		endpointKey: DeviceConfigKey | null;
	}
>;

export const TransformError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	NoSteps: ({ message }: { message: string }) => ({ message }),
	StepFailed: ({ message }: { message: string }) => ({ message }),
});
export type TransformError = InferErrors<typeof TransformError>;

type StepError = string | { message: string };

async function handleStep({
	input,
	step,
}: {
	input: string;
	step: TransformationStep;
}): Promise<Result<string, StepError>> {
	switch (step.type) {
		case 'find_replace': {
			const { findText, replaceText, useRegex } = step;

			if (useRegex) {
				try {
					const regex = new RegExp(findText, 'g');
					return Ok(input.replace(regex, replaceText));
				} catch (error) {
					return Err(`Invalid regex pattern: ${extractErrorMessage(error)}`);
				}
			}

			return Ok(input.replaceAll(findText, replaceText));
		}

		case 'prompt_transform': {
			const { inferenceProvider, systemPromptTemplate, userPromptTemplate } =
				step;
			const systemPrompt = interpolateTemplate(
				asTemplateString(systemPromptTemplate),
				{ input },
			);
			const userPrompt = interpolateTemplate(
				asTemplateString(userPromptTemplate),
				{ input },
			);

			const config = COMPLETION_PROVIDERS[inferenceProvider];

			// Trim everything once here: keys, model names, and URLs are
			// pasted strings, and a trailing space fails the request opaquely.
			return config.service.complete({
				apiKey: deviceConfig.get(config.apiKeyKey).trim(),
				model: step[INFERENCE[inferenceProvider].stepModelField].trim(),
				baseUrl: config.endpointKey
					? deviceConfig.get(config.endpointKey).trim() || undefined
					: undefined,
				systemPrompt,
				userPrompt,
			});
		}

		default:
			return Err(`Unsupported step type: ${step.type}`);
	}
}

/**
 * Run a transformation pipeline. Persists run + step-run records to workspace
 * state as it progresses (including the failed state when a step throws);
 * the returned Result is purely for caller control flow. Pure orchestration;
 * no toasts, no notifications.
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

	const steps = transformationSteps.getByTransformationId(transformation.id);

	if (steps.length === 0) {
		return TransformError.NoSteps({
			message:
				'No steps configured. Please add at least one transformation step',
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
		result: { status: 'running' },
	} satisfies TransformationRun;

	transformationRuns.set(transformationRun);

	let currentInput = input;

	for (const [stepIndex, step] of steps.entries()) {
		const stepRunId = nanoid();
		const stepRun = {
			id: stepRunId,
			transformationRunId: runId,
			stepId: step.id,
			order: stepIndex,
			input: currentInput,
			startedAt: new Date().toISOString(),
			result: { status: 'running' },
		} satisfies TransformationStepRun;
		transformationStepRuns.set(stepRun);

		const handleStepResult = await handleStep({
			input: currentInput,
			step,
		});

		if (isErr(handleStepResult)) {
			const stepError = extractErrorMessage(handleStepResult.error);
			const failedNow = new Date().toISOString();
			transformationStepRuns.set({
				...stepRun,
				result: {
					status: 'failed',
					completedAt: failedNow,
					error: stepError,
				},
			});
			transformationRuns.set({
				...transformationRun,
				result: {
					status: 'failed',
					completedAt: failedNow,
					error: stepError,
				},
			} satisfies TransformationRun);
			return TransformError.StepFailed({ message: stepError });
		}

		const handleStepOutput = handleStepResult.data;

		transformationStepRuns.set({
			...stepRun,
			result: {
				status: 'completed',
				completedAt: new Date().toISOString(),
				output: handleStepOutput,
			},
		});

		currentInput = handleStepOutput;
	}

	transformationRuns.set({
		...transformationRun,
		result: {
			status: 'completed',
			completedAt: new Date().toISOString(),
			output: currentInput,
		},
	} satisfies TransformationRun);
	return Ok(currentInput);
}
