import { invoke } from '@tauri-apps/api/core';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

export const AudioEncoderError = defineErrors({
	EncodeFailed: ({ cause }: { cause: unknown }) => ({
		message: `Audio encode failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AudioEncoderError = InferErrors<typeof AudioEncoderError>;

/**
 * Compress a WAV blob into OGG/Opus via the in-process Rust libopus encoder.
 *
 * Bound to the `encode_upload_audio` Tauri command. Audio bytes travel as
 * the raw IPC body so the call doesn't pay JSON-array-of-bytes overhead.
 *
 * Returns the OGG/Opus bytes ready to upload as `audio/ogg`. Callers should
 * fall back to uploading the original WAV blob on error rather than failing
 * the whole transcription: compression is an optimization, not a correctness
 * requirement.
 */
export const AudioEncoderServiceLive = {
	async encodeWavToOpusOgg(
		wavBlob: Blob,
	): Promise<Result<Blob, AudioEncoderError>> {
		const { data: oggBytes, error } = await tryAsync({
			try: async () => {
				const wavBuffer = await wavBlob.arrayBuffer();
				return await invoke<ArrayBuffer>('encode_upload_audio', wavBuffer);
			},
			catch: (cause) => AudioEncoderError.EncodeFailed({ cause }),
		});

		if (error) return Err(error);

		return Ok(new Blob([oggBytes], { type: 'audio/ogg' }));
	},
};
