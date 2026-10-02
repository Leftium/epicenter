import {
	type CreateRowOf,
	type DataDefinition,
	defineTable,
	field,
	type KvOf,
} from '@epicenter/definition';

/**
 * Whispering's folder: each recording is `recordings/<id>.md` with its
 * metadata in frontmatter and notes in the Markdown body. The row names its
 * audio in `audioPath`; the audio is an ordinary file the table does not own,
 * so nothing is inferred from a file that happens to share the row's stem.
 * Each transcription result is its own row in `transcriptions/`, naming the
 * recording it was made from, with the transcript as its body. Settings that
 * travel with the folder live in `kv.json`.
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
 *
 * The page and the Bun folder host both load this module, so it names only
 * the inert vocabulary. Each opener checks the definition before it acquires
 * anything, and `definition.test.ts` checks it with `defineFolder`.
 */
export const whisperingDefinition = {
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
				/**
				 * The folder-relative path of the audio file, such as
				 * `recordings/20260102-030405-k3f9.wav`. A row without it has no
				 * audio the app will play, transcribe, or name.
				 */
				audioPath: field.string(),
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
} as const satisfies DataDefinition;

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

/** Where a new capture's audio is saved. An existing row's audio is whatever its `audioPath` says. */
export function recordingAudioPath(id: string, extension: string): string {
	return `${RECORDINGS}/${id}.${extension}`;
}

/**
 * The audio a recording row names, or undefined when it names none. A row
 * written before `audioPath` existed names none: it is listed as needing
 * repair, and no file is guessed from its stem.
 */
export function audioPathIn(
	fields: Readonly<Partial<RecordingFields>>,
): string | undefined {
	const path = fields.audioPath;
	return typeof path === 'string' && path !== '' ? path : undefined;
}

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
