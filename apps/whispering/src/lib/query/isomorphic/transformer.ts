import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result, trySync } from 'wellcrafted/result';
import type { InferenceProviderId } from '$lib/constants/inference';
import { defineMutation, queryClient } from '$lib/query/client';
import {
	WhisperingErr,
	type WhisperingError,
	type WhisperingResult,
} from '$lib/result';
import { services } from '$lib/services';
import type { CompletionService } from '$lib/services/isomorphic/completion/types';
import type {
	Transformation,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationRunRunning,
	TransformationStep,
} from '$lib/services/isomorphic/db';
import type { Settings } from '$lib/settings';
import { settings } from '$lib/state/settings.svelte';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';
import { dbKeys } from './db';

type ProviderEntry = {
	service: CompletionService;
	getApiKey: (s: Settings) => string;
	getModel: (step: TransformationStep) => string;
	getBaseUrl?: (step: TransformationStep, s: Settings) => string;
};

/** Maps each provider to its service + config extractors. Explicit type ensures exhaustiveness. */
const completionProviderRegistry: Record<InferenceProviderId, ProviderEntry> = {
	OpenAI: {
		service: services.completions.openai,
		getApiKey: (s) => s['apiKeys.openai'],
		getModel: (step) =>
			step['prompt_transform.inference.provider.OpenAI.model'],
	},
	Groq: {
		service: services.completions.groq,
		getApiKey: (s) => s['apiKeys.groq'],
		getModel: (step) => step['prompt_transform.inference.provider.Groq.model'],
	},
	Anthropic: {
		service: services.completions.anthropic,
		getApiKey: (s) => s['apiKeys.anthropic'],
		getModel: (step) =>
			step['prompt_transform.inference.provider.Anthropic.model'],
	},
	Google: {
		service: services.completions.google,
		getApiKey: (s) => s['apiKeys.google'],
		getModel: (step) =>
			step['prompt_transform.inference.provider.Google.model'],
	},
	OpenRouter: {
		service: services.completions.openrouter,
		getApiKey: (s) => s['apiKeys.openrouter'],
		getModel: (step) =>
			step['prompt_transform.inference.provider.OpenRouter.model'],
	},
	Custom: {
		service: services.completions.custom,
		getApiKey: (s) => s['apiKeys.custom'],
		getModel: (step) =>
			step['prompt_transform.inference.provider.Custom.model']?.trim(),
		getBaseUrl: (step, s) => {
			// baseUrl is per-step because local LLM setups often have multiple endpoints
			// (Ollama, LM Studio, llama.cpp) running on different ports
			const stepBaseUrl =
				step['prompt_transform.inference.provider.Custom.baseUrl']?.trim();
			// Fall back to global default from Settings → API Keys → Custom section
			const defaultBaseUrl = s['completion.custom.baseUrl']?.trim();
			// Use || so empty string falls back to next value (cleared field = use default)
			return stepBaseUrl || defaultBaseUrl || '';
		},
	},
};

export const TransformError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	NoSteps: ({ message }: { message: string }) => ({ message }),
	DbCreateRunFailed: ({ message }: { message: string }) => ({ message }),
	DbAddStepFailed: ({ message }: { message: string }) => ({ message }),
	DbFailStepFailed: ({ message }: { message: string }) => ({ message }),
	DbCompleteStepFailed: ({ message }: { message: string }) => ({ message }),
	DbCompleteRunFailed: ({ message }: { message: string }) => ({ message }),
});
export type TransformError = InferErrors<typeof TransformError>;

const transformerKeys = {
	transformInput: ['transformer', 'transformInput'] as const,
	transformRecording: ['transformer', 'transformRecording'] as const,
};

export const transformer = {
	transformInput: defineMutation({
		mutationKey: transformerKeys.transformInput,
		mutationFn: async ({
			input,
			transformation,
		}: {
			input: string;
			transformation: Transformation;
		}): Promise<WhisperingResult<string>> => {
			const getTransformationOutput = async (): Promise<
				Result<string, WhisperingError>
			> => {
				const { data: transformationRun, error: transformationRunError } =
					await runTransformation({
						input,
						transformation,
						recordingId: null,
					});

				if (transformationRunError)
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						serviceError: transformationRunError,
					});

				if (transformationRun.status === 'failed') {
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						description: transformationRun.error,
						action: { type: 'more-details', error: transformationRun.error },
					});
				}

				if (!transformationRun.output) {
					return WhisperingErr({
						title: '⚠️ Transformation produced no output',
						description: 'The transformation completed but produced no output.',
					});
				}

				return Ok(transformationRun.output);
			};

			const transformationOutputResult = await getTransformationOutput();

			queryClient.invalidateQueries({
				queryKey: dbKeys.runs.byTransformationId(transformation.id),
			});
			queryClient.invalidateQueries({
				queryKey: dbKeys.transformations.byId(transformation.id),
			});

			return transformationOutputResult;
		},
	}),

	transformRecording: defineMutation({
		mutationKey: transformerKeys.transformRecording,
		mutationFn: async ({
			recordingId,
			transformation,
		}: {
			recordingId: string;
			transformation: Transformation;
		}): Promise<
			Result<
				TransformationRunCompleted | TransformationRunFailed,
				WhisperingError
			>
		> => {
			const { data: recording, error: getRecordingError } =
				await services.db.recordings.getById(recordingId);
			if (getRecordingError || !recording) {
				return WhisperingErr({
					title: '⚠️ Recording not found',
					description:
						getRecordingError?.message ??
						'Could not find the selected recording.',
				});
			}

			const { data: transformationRun, error: transformationRunError } =
				await runTransformation({
					input: recording.transcribedText,
					transformation,
					recordingId,
				});

			if (transformationRunError)
				return WhisperingErr({
					title: '⚠️ Transformation failed',
					serviceError: transformationRunError,
				});

			queryClient.invalidateQueries({
				queryKey: dbKeys.runs.byRecordingId(recordingId),
			});
			queryClient.invalidateQueries({
				queryKey: dbKeys.runs.byTransformationId(transformation.id),
			});
			queryClient.invalidateQueries({
				queryKey: dbKeys.transformations.byId(transformation.id),
			});

			return Ok(transformationRun);
		},
	}),
};

async function handleStep({
	input,
	step,
}: {
	input: string;
	step: TransformationStep;
}): Promise<Result<string, string>> {
	switch (step.type) {
		case 'find_replace': {
			const findText = step['find_replace.findText'];
			const replaceText = step['find_replace.replaceText'];
			const useRegex = step['find_replace.useRegex'];

			if (useRegex) {
				return trySync({
					try: () => {
						const regex = new RegExp(findText, 'g');
						return input.replace(regex, replaceText);
					},
					catch: (error) =>
						Err(`Invalid regex pattern: ${extractErrorMessage(error)}`),
				});
			}

			return Ok(input.replaceAll(findText, replaceText));
		}

		case 'prompt_transform': {
			const provider = step['prompt_transform.inference.provider'];
			const systemPrompt = interpolateTemplate(
				asTemplateString(step['prompt_transform.systemPromptTemplate']),
				{ input },
			);
			const userPrompt = interpolateTemplate(
				asTemplateString(step['prompt_transform.userPromptTemplate']),
				{ input },
			);

			const entry = completionProviderRegistry[provider];
			const { data, error } = await entry.service.complete({
				apiKey: entry.getApiKey(settings.value),
				model: entry.getModel(step),
				baseUrl: entry.getBaseUrl?.(step, settings.value),
				systemPrompt,
				userPrompt,
			});

			if (error) return Err(error.message);
			return Ok(data);
		}

		default:
			return Err(`Unsupported step type: ${step.type}`);
	}
}

async function runTransformation({
	input,
	transformation,
	recordingId,
}: {
	input: string;
	transformation: Transformation;
	recordingId: string | null;
}): Promise<
	Result<TransformationRunCompleted | TransformationRunFailed, TransformError>
> {
	if (!input.trim()) {
		return TransformError.InvalidInput({
			message: 'Empty input. Please enter some text to transform',
		});
	}

	if (transformation.steps.length === 0) {
		return TransformError.NoSteps({
			message:
				'No steps configured. Please add at least one transformation step',
		});
	}

	const transformationRun = {
		id: nanoid(),
		transformationId: transformation.id,
		recordingId,
		input,
		startedAt: new Date().toISOString(),
		completedAt: null,
		status: 'running',
		stepRuns: [],
	} satisfies TransformationRunRunning;

	const { error: createTransformationRunError } =
		await services.db.runs.create(transformationRun);

	if (createTransformationRunError)
		return TransformError.DbCreateRunFailed({
			message: 'Unable to start transformation run',
		});

	let currentInput = input;

	for (const step of transformation.steps) {
		const {
			data: newTransformationStepRun,
			error: addTransformationStepRunError,
		} = await services.db.runs.addStep(transformationRun, {
			id: step.id,
			input: currentInput,
		});

		if (addTransformationStepRunError)
			return TransformError.DbAddStepFailed({
				message: 'Unable to initialize transformation step',
			});

		const handleStepResult = await handleStep({
			input: currentInput,
			step,
		});

		if (isErr(handleStepResult)) {
			const {
				data: markedFailedTransformationRun,
				error: markTransformationRunAndRunStepAsFailedError,
			} = await services.db.runs.failStep(
				transformationRun,
				newTransformationStepRun.id,
				handleStepResult.error,
			);
			if (markTransformationRunAndRunStepAsFailedError)
				return TransformError.DbFailStepFailed({
					message: 'Unable to save failed transformation step result',
				});
			return Ok(markedFailedTransformationRun);
		}

		const handleStepOutput = handleStepResult.data;

		const { error: markTransformationRunStepAsCompletedError } =
			await services.db.runs.completeStep(
				transformationRun,
				newTransformationStepRun.id,
				handleStepOutput,
			);

		if (markTransformationRunStepAsCompletedError)
			return TransformError.DbCompleteStepFailed({
				message: 'Unable to save completed transformation step result',
			});

		currentInput = handleStepOutput;
	}

	const {
		data: markedCompletedTransformationRun,
		error: markTransformationRunAsCompletedError,
	} = await services.db.runs.complete(transformationRun, currentInput);

	if (markTransformationRunAsCompletedError)
		return TransformError.DbCompleteRunFailed({
			message: 'Unable to save completed transformation run',
		});
	return Ok(markedCompletedTransformationRun);
}
