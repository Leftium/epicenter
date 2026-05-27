import type { AnyTaggedError } from 'wellcrafted/error';
import { Err, Ok, partitionResults, type Result } from 'wellcrafted/result';
import { transcribeAudio } from '$lib/operations/transcribe';
import { defineMutation, queryClient } from '$lib/rpc/client';
import { services } from '$lib/services';
import type { BlobError } from '$lib/services/blob-store';
import type { Recording } from '$lib/state/recordings.svelte';
import { recordings } from '$lib/state/recordings.svelte';

const isTranscribingKey = ['transcription', 'isTranscribing'] as const;

export const transcription = {
	isCurrentlyTranscribing() {
		return (
			queryClient.isMutating({ mutationKey: isTranscribingKey }) > 0
		);
	},
	transcribeRecording: defineMutation({
		mutationKey: isTranscribingKey,
		mutationFn: async (
			recording: Recording,
		): Promise<Result<string, BlobError | AnyTaggedError>> => {
			const { data: audioBlob, error: getAudioBlobError } =
				await services.blobs.audio.getBlob(recording.id);

			if (getAudioBlobError) return Err(getAudioBlobError);

			recordings.update(recording.id, { transcriptionStatus: 'TRANSCRIBING' });
			const { data: transcribedText, error: transcribeError } =
				await transcribeAudio(audioBlob);
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
		mutationKey: isTranscribingKey,
		mutationFn: async (recordings: Recording[]) => {
			const results = await Promise.all(
				recordings.map(async (recording) => {
					const { data: audioBlob, error: getAudioBlobError } =
						await services.blobs.audio.getBlob(recording.id);

					if (getAudioBlobError) return Err(getAudioBlobError);

					return await transcribeAudio(audioBlob);
				}),
			);
			const partitionedResults = partitionResults(results);
			return Ok(partitionedResults);
		},
	}),
};
