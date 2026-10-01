import {
	type CreateRowOf,
	defineStore,
	defineTable,
	field,
	type KvOf,
} from '@epicenter/app';

/**
 * Whispering's folder: each recording is `recordings/<id>.md` with its
 * metadata in frontmatter, notes in the Markdown body, and zero or one
 * same-stem audio file beside it. Each transcription result is its own row in
 * `transcriptions/`, naming the recording it was made from, with the transcript
 * as its body. Settings that travel with the folder live in `kv.json`.
 *
 * The file stem is a row's identity. A recording's title is a field, so
 * renaming a recording never moves a file or breaks a result's `recordingId`.
 */
export const whisperingDefinition = defineStore({
	id: 'so.epicenter.whispering',
	title: 'Whispering',
	kv: {
		/** An OpenAI-compatible base URL, such as `https://api.openai.com/v1`. */
		transcriptionBaseUrl: field.string(),
		transcriptionModel: field.string(),
	},
	tables: {
		recordings: defineTable({
			fields: {
				title: field.string(),
				recordedAt: field.instant(),
				durationMs: field.number(),
				/** Where the audio came from, so fixture audio is never mistaken for a microphone take. */
				capture: field.select(['microphone', 'fixture']),
			},
		}),
		transcriptions: defineTable({
			fields: {
				recordingId: field.string(),
				createdAt: field.instant(),
				model: field.string(),
				endpoint: field.string(),
			},
		}),
	},
});

export type CaptureSource = 'microphone' | 'fixture';

export type RecordingFields = CreateRowOf<
	typeof whisperingDefinition.tables.recordings
>;
export type TranscriptionFields = CreateRowOf<
	typeof whisperingDefinition.tables.transcriptions
>;
export type TranscriptionSettings = KvOf<typeof whisperingDefinition>;

export const RECORDINGS = 'recordings';
export const TRANSCRIPTIONS = 'transcriptions';

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
	transcriptionBaseUrl: 'https://api.openai.com/v1',
	transcriptionModel: 'whisper-1',
};

/** `recordings/<id>.md` and nothing nested below it. */
export const RECORDING_ROW = /^recordings\/([^/]+)\.md$/;

export function recordingIdOf(path: string): string | undefined {
	return RECORDING_ROW.exec(path)?.[1];
}
