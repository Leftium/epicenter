import { Ok, type Result } from 'wellcrafted/result';
import { runTransformation } from '$lib/operations/transform';
import { defineMutation } from '$lib/query/client';
import {
	WhisperingErr,
	type WhisperingError,
	type WhisperingResult,
} from '$lib/result';
import { recordings } from '$lib/state/recordings.svelte';
import type {
	TerminalTransformationRunResult,
	Transformation,
} from '$lib/workspace';

const transformerKeys = {
	transformInput: ['transformer', 'transformInput'] as const,
	transformRecording: ['transformer', 'transformRecording'] as const,
};

/**
 * Observed mutations around runTransformation. The pipeline logic lives in
 * $lib/operations/transform; this file just wraps it with TanStack mutation
 * surface for components that need pending state.
 */
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
			const { data: result, error: runError } = await runTransformation({
				input,
				transformation,
				recordingId: null,
			});

			if (runError)
				return WhisperingErr({
					title: '⚠️ Transformation failed',
					serviceError: runError,
				});

			if (result.status === 'failed')
				return WhisperingErr({
					title: '⚠️ Transformation failed',
					description: result.error,
					action: { type: 'more-details', error: result.error },
				});

			return Ok(result.output);
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
		}): Promise<Result<TerminalTransformationRunResult, WhisperingError>> => {
			const recording = recordings.get(recordingId);
			if (!recording) {
				return WhisperingErr({
					title: '⚠️ Recording not found',
					description: 'Could not find the selected recording.',
				});
			}

			const { data: result, error: runError } = await runTransformation({
				input: recording.transcript,
				transformation,
				recordingId,
			});

			if (runError)
				return WhisperingErr({
					title: '⚠️ Transformation failed',
					serviceError: runError,
				});

			return Ok(result);
		},
	}),
};
