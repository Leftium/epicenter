/**
 * Vocab dictation: record a phrase, transcribe it through the OpenAI-compatible
 * speech-to-text wire, and hand back the text. One device-wide singleton (there
 * is one mic), composed from the minimal {@link createRecorder} and the shared
 * `transcribe` client.
 *
 * Transcription is a stateless service (the spec's star/service/library model):
 * this holds no preferences and reaches for no sync. It pulls only the device
 * connection registry and Vocab's own app-local model + language constants.
 *
 * The transport comes from `resolveOrHosted(VOCAB_STT_MODEL)`, the same predicate
 * chat uses. `whisper-1` is not in Vocab's hosted *chat* catalog, so nothing
 * "serves" it and the call falls back to the hosted transport: the STT gateway on
 * the same `<origin>/v1` Connection base, zero setup, metered. A user who added
 * their own OpenAI key that serves `whisper-1` dictates through that key instead,
 * off Epicenter credits, exactly like a custom chat model resolves first. So the
 * honest path is the registry's, not a hosted transport rebuilt here.
 */

import { transcribe, type TranscribeError } from '@epicenter/client';
import { VOCAB_DICTATION_LANGUAGE, VOCAB_STT_MODEL } from '@epicenter/vocab';
import { Err, type Result } from 'wellcrafted/result';
import { inferenceConnections } from './inference-connections.svelte';
import { createRecorder, type RecorderError } from './recorder.svelte';

/** Where dictation is in its idle -> recording -> transcribing -> idle cycle. */
export type DictationStatus = 'idle' | 'recording' | 'transcribing';

function createDictation() {
	const recorder = createRecorder();
	let isTranscribing = $state(false);

	return {
		/** The one status the mic button reads; recomputed from the two reactive sources. */
		get status(): DictationStatus {
			if (isTranscribing) return 'transcribing';
			return recorder.isRecording ? 'recording' : 'idle';
		},

		/** Open the mic and begin capturing. */
		start() {
			return recorder.start();
		},

		/** Stop, transcribe the captured audio through the hosted gateway, return the text. */
		async stopAndTranscribe(): Promise<
			Result<string, RecorderError | TranscribeError>
		> {
			const { data: audio, error: recordError } = await recorder.stop();
			if (recordError) return Err(recordError);

			isTranscribing = true;
			try {
				const transport = inferenceConnections.resolveOrHosted(VOCAB_STT_MODEL);
				return await transcribe(audio, transport, {
					model: VOCAB_STT_MODEL,
					language: VOCAB_DICTATION_LANGUAGE,
				});
			} finally {
				isTranscribing = false;
			}
		},
	};
}

export const dictation = createDictation();
