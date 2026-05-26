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
 * the raw IPC body; the bitrate goes in the `x-encode-bitrate` header so
 * the call doesn't have to JSON-serialize the audio payload.
 *
 * Returns the OGG/Opus bytes ready to upload as `audio/ogg`. Callers should
 * fall back to uploading the original WAV blob on error rather than failing
 * the whole transcription: compression is an optimization, not a correctness
 * requirement.
 */
export const AudioEncoderServiceLive = {
	async encodeWavToOpusOgg(
		wavBlob: Blob,
		options: { bitrateBps?: number } = {},
	): Promise<Result<Blob, AudioEncoderError>> {
		const { data: oggBytes, error } = await tryAsync({
			try: async () => {
				const wavBuffer = await wavBlob.arrayBuffer();
				const headers: Record<string, string> = {};
				if (options.bitrateBps !== undefined) {
					headers['x-encode-bitrate'] = String(options.bitrateBps);
				}
				return await invoke<ArrayBuffer>(
					'encode_upload_audio',
					wavBuffer,
					Object.keys(headers).length > 0 ? { headers } : undefined,
				);
			},
			catch: (cause) => AudioEncoderError.EncodeFailed({ cause }),
		});

		if (error) return Err(error);

		return Ok(new Blob([oggBytes], { type: 'audio/ogg' }));
	},
};
