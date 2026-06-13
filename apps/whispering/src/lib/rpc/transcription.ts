import { type AnyTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { defineKeys } from 'wellcrafted/query';
import { Err, Ok, partitionResults, type Result } from 'wellcrafted/result';
import { transcribeAudio } from '$lib/operations/transcribe';
import { defineMutation, queryClient } from '$lib/rpc/client';
import type { Recording } from '$lib/state/recordings.svelte';
import { recordings } from '$lib/state/recordings.svelte';

export const transcriptionKeys = defineKeys({
	isTranscribing: ['transcription', 'isTranscribing'],
});

export const transcription = {
	isCurrentlyTranscribing() {
		return (
			queryClient.isMutating({
				mutationKey: transcriptionKeys.isTranscribing,
			}) > 0
		);
	},
	transcribeRecording: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (
			recording: Recording,
		): Promise<Result<string, AnyTaggedError>> => {
			const { data: transcribedText, error: transcribeError } =
				await transcribeAudio(recording.id);
			if (transcribeError) {
				recordings.update(recording.id, {
					transcription: {
						status: 'failed',
						completedAt: new Date().toISOString(),
						error: extractErrorMessage(transcribeError),
					},
				});
				return Err(transcribeError);
			}

			recordings.update(recording.id, {
				transcript: transcribedText,
				transcription: {
					status: 'completed',
					completedAt: new Date().toISOString(),
				},
			});
			return Ok(transcribedText);
		},
	}),

	transcribeRecordings: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (recordings: Recording[]) => {
			const results = await Promise.all(
				recordings.map((recording) => transcribeAudio(recording.id)),
			);
			const partitionedResults = partitionResults(results);
			return Ok(partitionedResults);
		},
	}),
};
