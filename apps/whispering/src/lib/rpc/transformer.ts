import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { defineKeys } from 'wellcrafted/query';
import type { Result } from 'wellcrafted/result';
import {
	executeTransformation,
	runTransformation,
	type TransformError,
} from '$lib/operations/transform';
import { defineMutation } from '$lib/rpc/client';
import { recordings } from '$lib/state/recordings.svelte';
import type { Transformation } from '$lib/workspace';

const TransformerRpcError = defineErrors({
	RecordingNotFound: () => ({
		message: 'Could not find the selected recording.',
	}),
});
type TransformerRpcError = InferErrors<typeof TransformerRpcError>;

type TransformInputParams = {
	input: string;
	transformation: Transformation;
};

type TransformRecordingParams = {
	recordingId: string;
	transformation: Transformation;
};

export const transformerKeys = defineKeys({
	transformInput: ['transformer', 'transformInput'],
	transformRecording: ['transformer', 'transformRecording'],
});

/**
 * Observed mutations around the transformation engine. The logic lives in
 * $lib/operations/transform; this file wraps it with a TanStack mutation surface
 * for components that need pending state.
 */
export const transformer = {
	/**
	 * Non-persisting preview: runs the transformation purely and returns the
	 * output without writing a run. The transformations editor's Test pane uses
	 * this, so scratch previews never land in run history.
	 */
	transformInput: defineMutation({
		mutationKey: transformerKeys.transformInput,
		mutationFn: ({
			input,
			transformation,
		}: TransformInputParams): Promise<Result<string, TransformError>> =>
			executeTransformation({ input, transformation }),
	}),

	transformRecording: defineMutation({
		mutationKey: transformerKeys.transformRecording,
		mutationFn: ({
			recordingId,
			transformation,
		}: TransformRecordingParams): Promise<
			Result<string, TransformError | TransformerRpcError>
		> => {
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
