import { Err, Ok, partitionResults, type Result } from 'wellcrafted/result';
import { transcribeAudio } from '$lib/operations/transcribe';
import type { WhisperingError } from '$lib/result';
import { defineMutation, queryClient } from '$lib/rpc/client';
import type { Recording } from '$lib/state/recordings.svelte';
import { recordings } from '$lib/state/recordings.svelte';

const transcriptionKeys = {
	isTranscribing: ['transcription', 'isTranscribing'] as const,
} as const;

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
		): Promise<Result<string, WhisperingError>> => {
			recordings.update(recording.id, { transcriptionStatus: 'TRANSCRIBING' });
			const { data: transcribedText, error: transcribeError } =
				await transcribeAudio(recording.id);
			if (transcribeError) {
				recordings.update(recording.id, { transcriptionStatus: 'FAILED' });
				return Err(transcribeError);
			}

			recordings.update(recording.id, {
				transcript: transcribedText,
				transcriptionStatus: 'DONE',
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
