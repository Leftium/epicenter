import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import {
	runTransformation,
	type TransformError,
} from '$lib/operations/transform';
import { defineMutation } from '$lib/rpc/client';
import { transformerKeys } from '$lib/rpc/keys';
import { recordings } from '$lib/state/recordings.svelte';
import type { Transformation } from '$lib/workspace';

const TransformerRpcError = defineErrors({
	RecordingNotFound: () => ({
		message: 'Could not find the selected recording.',
	}),
});
type TransformerRpcError = InferErrors<typeof TransformerRpcError>;

/**
 * Observed mutations around runTransformation. The pipeline logic lives in
 * $lib/operations/transform; this file just wraps it with TanStack mutation
 * surface for components that need pending state.
 */
export const transformer = {
	transformInput: defineMutation({
		mutationKey: transformerKeys.transformInput,
		mutationFn: ({
			input,
			transformation,
		}: {
			input: string;
			transformation: Transformation;
		}): Promise<Result<string, TransformError>> =>
			runTransformation({ input, transformation, recordingId: null }),
	}),

	transformRecording: defineMutation({
		mutationKey: transformerKeys.transformRecording,
		mutationFn: ({
			recordingId,
			transformation,
		}: {
			recordingId: string;
			transformation: Transformation;
		}): Promise<Result<string, TransformError | TransformerRpcError>> => {
			const recording = recordings.get(recordingId);
			if (!recording)
				return Promise.resolve(TransformerRpcError.RecordingNotFound());

			return runTransformation({
				input: recording.transcript,
				transformation,
				recordingId,
			});
		},
	}),
};
