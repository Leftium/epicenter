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
 * A transformation is a reusable prompt: `transformations/<id>.md` with its
 * title, model, and endpoint in frontmatter and the prompt as its body.
 * Applying one to a transcript writes a new row in `transformation_runs/` with
 * the output as its body. That row names the recording, transcription, and
 * transformation it came from and carries the prompt and transcript text that
 * were sent, so it still reads correctly after any of them changes or is
 * deleted. The transcription row is never written.
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
		transformations: defineTable({
			fields: {
				title: field.string(),
				/** The chat model the endpoint serves, such as `gpt-4o-mini`. */
				model: field.string(),
				/** An OpenAI-compatible base URL. The request goes to `/chat/completions` under it. */
				endpoint: field.string(),
			},
		}),
		// A table name is one bare identifier, so the folder cannot be `transformation-runs`.
		transformation_runs: defineTable({
			fields: {
				recordingId: field.string(),
				transcriptionId: field.string(),
				transformationId: field.string(),
				/** The transformation's title when it ran. */
				transformationTitle: field.string(),
				createdAt: field.instant(),
				model: field.string(),
				endpoint: field.string(),
				/** The prompt that was sent, exactly. */
				prompt: field.string(),
				/** The transcript text that was sent, exactly. */
				input: field.string(),
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
export type TransformationFields = CreateRowOf<
	typeof whisperingDefinition.tables.transformations
>;
export type TransformationRunFields = CreateRowOf<
	typeof whisperingDefinition.tables.transformation_runs
>;
export type TranscriptionSettings = KvOf<typeof whisperingDefinition>;

export const RECORDINGS = 'recordings';
export const TRANSCRIPTIONS = 'transcriptions';
export const TRANSFORMATIONS = 'transformations';
export const TRANSFORMATION_RUNS = 'transformation_runs';

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
	transcriptionBaseUrl: 'https://api.openai.com/v1',
	transcriptionModel: 'whisper-1',
};

/** `recordings/<id>.md` and nothing nested below it. */
export const RECORDING_ROW = /^recordings\/([^/]+)\.md$/;

export function recordingIdOf(path: string): string | undefined {
	return RECORDING_ROW.exec(path)?.[1];
}

/** `transcriptions/<id>.md` and nothing nested below it. */
export const TRANSCRIPTION_ROW = /^transcriptions\/([^/]+)\.md$/;

/** `transformations/<id>.md` and nothing nested below it. */
export const TRANSFORMATION_ROW = /^transformations\/([^/]+)\.md$/;

/**
 * Prompts offered as explicit "create" buttons. Nothing is written to the
 * folder until one is pressed, and the file it creates is an ordinary
 * transformation the person can edit or delete.
 */
export const STARTER_TRANSFORMATIONS: readonly {
	readonly title: string;
	readonly prompt: string;
}[] = [
	{
		title: 'Clean up',
		prompt:
			'You clean up dictated text. Fix punctuation, capitalization, and obvious transcription mistakes. Remove filler words and false starts. Keep the speaker’s wording and meaning. Answer with the cleaned text only.\n',
	},
	{
		title: 'Summarize',
		prompt:
			'You summarize transcripts. Write a short summary of the main points as a bulleted list, then list any action items. Use only what the transcript says. Answer with the summary only.\n',
	},
	{
		title: 'Draft an email',
		prompt:
			'You turn dictated notes into an email. Write a clear, polite email with a subject line, a greeting, short paragraphs, and a sign-off. Do not invent facts that are not in the notes. Answer with the email only.\n',
	},
];
