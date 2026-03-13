import {
	createWorkspace,
	defineKv,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';

// ── Constant imports ─────────────────────────────────────────────────────────

import { RECORDING_MODES } from '$lib/constants/audio/recording-modes';
import { INFERENCE_PROVIDER_IDS } from '$lib/constants/inference';
import { TRANSCRIPTION_SERVICE_IDS } from '$lib/constants/transcription';
import { ALWAYS_ON_TOP_MODES } from '$lib/constants/ui/always-on-top';
import { LAYOUT_MODES } from '$lib/constants/ui/layout-mode';

/**
 * Tables store normalized domain entities. Each row is replaced atomically via
 * `table.set()` — there's no field-level merging. Schemas validate on read, so old
 * data stays in storage until explicitly rewritten.
 */
/** Audio recordings captured by the user. One row per recording session. */
const recordings = defineTable(
	type({
		id: 'string',
		title: 'string',
		subtitle: 'string',
		timestamp: 'string',
		createdAt: 'string',
		updatedAt: 'string',
		transcribedText: 'string',
		transcriptionStatus: "'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'",
		_v: '1',
	}),
);

/** User-defined transformation pipelines. Each transformation has ordered steps. */
const transformations = defineTable(
	type({
		id: 'string',
		title: 'string',
		description: 'string',
		createdAt: 'string',
		updatedAt: 'string',
		_v: '1',
	}),
);

/**
 * Individual steps within a transformation pipeline.
 *
 * Uses a flat row schema — all `prompt_transform` and `find_replace` fields are
 * present on every row, discriminated by the `type` field. This is intentional:
 *
 * - `table.set()` replaces the entire row. A discriminated union would lose the
 *   inactive variant's data on every write. Flat rows preserve everything.
 * - Per-provider model memory: each inference provider's model selection is stored
 *   independently. Switching providers and switching back retains your choices.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 1}
 */
const transformationSteps = defineTable(
	type({
		id: 'string',
		transformationId: 'string',
		order: 'number',
		type: "'prompt_transform' | 'find_replace'",

		// Prompt transform: active provider
		inferenceProvider: type.enumerated(...INFERENCE_PROVIDER_IDS),

		// Prompt transform: per-provider model memory
		openaiModel: 'string',
		groqModel: 'string',
		anthropicModel: 'string',
		googleModel: 'string',
		openrouterModel: 'string',
		customModel: 'string',
		customBaseUrl: 'string',

		// Prompt transform: prompt templates
		systemPromptTemplate: 'string',
		userPromptTemplate: 'string',

		// Find & replace
		findText: 'string',
		replaceText: 'string',
		useRegex: 'boolean',

		_v: '1',
	}),
);

/**
 * Execution records for transformation pipelines. One run per invocation.
 *
 * Uses a discriminated union on `status`—unlike `transformationSteps` (which uses
 * flat rows to preserve per-provider model memory across type switches), runs have
 * one-way state transitions (running → completed | failed) with no data to preserve
 * across states. The union ensures `output` exists only on completed runs and `error`
 * exists only on failed runs, eliminating null checks after status narrowing.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 1}
 */
const TransformationRunBase = type({
	id: 'string',
	transformationId: 'string',
	recordingId: 'string | null',
	input: 'string',
	startedAt: 'string',
	completedAt: 'string | null',
	_v: '1',
});

const transformationRuns = defineTable(
	TransformationRunBase.merge(
		type.or(
			{ status: "'running'" },
			{ status: "'completed'", output: 'string' },
			{ status: "'failed'", error: 'string' },
		),
	),
);

/**
 * Per-step execution records within a transformation run.
 *
 * Same discriminated union pattern as `transformationRuns`—`output` and `error`
 * are only present on the relevant status variant.
 */
const TransformationStepRunBase = type({
	id: 'string',
	transformationRunId: 'string',
	stepId: 'string',
	order: 'number',
	input: 'string',
	startedAt: 'string',
	completedAt: 'string | null',
	_v: '1',
});

const transformationStepRuns = defineTable(
	TransformationStepRunBase.merge(
		type.or(
			{ status: "'running'" },
			{ status: "'completed'", output: 'string' },
			{ status: "'failed'", error: 'string' },
		),
	),
);

/**
 * Synced settings stored as individual KV entries with last-write-wins resolution.
 *
 * Each key is independently resolved — two devices can change different settings
 * simultaneously without one overwriting the other. Dot-notation keys create a
 * natural namespace hierarchy and give per-key LWW granularity (unlike table rows
 * which are replaced atomically).
 *
 * Only preferences that roam across devices live here. API keys, filesystem paths,
 * hardware device IDs, base URLs, and global shortcuts stay in localStorage.
 */
/**
 * Sound effect toggles. Each event can independently play/mute a sound.
 * Manual = user-initiated recording. VAD = voice activity detection.
 */
const sound = {
	'sound.manualStart': defineKv(type('boolean')),
	'sound.manualStop': defineKv(type('boolean')),
	'sound.manualCancel': defineKv(type('boolean')),
	'sound.vadStart': defineKv(type('boolean')),
	'sound.vadCapture': defineKv(type('boolean')),
	'sound.vadStop': defineKv(type('boolean')),
	'sound.transcriptionComplete': defineKv(type('boolean')),
	'sound.transformationComplete': defineKv(type('boolean')),
} as const;

/**
 * Output behavior after transcription/transformation completes.
 * Controls clipboard, cursor paste, and simulated Enter key per pipeline stage.
 */
const output = {
	'transcription.copyToClipboard': defineKv(type('boolean')),
	'transcription.writeToCursor': defineKv(type('boolean')),
	'transcription.simulateEnter': defineKv(type('boolean')),
	'transformation.copyToClipboard': defineKv(type('boolean')),
	'transformation.writeToCursor': defineKv(type('boolean')),
	'transformation.simulateEnter': defineKv(type('boolean')),
} as const;

/** Window behavior and navigation layout preferences. */
const ui = {
	'ui.alwaysOnTop': defineKv(type.enumerated(...ALWAYS_ON_TOP_MODES)),
	'ui.layoutMode': defineKv(type.enumerated(...LAYOUT_MODES)),
} as const;

/**
 * Recording retention policy. `maxCount` is stored as an integer — the old
 * settings schema used `string.digits` for localStorage; the workspace uses
 * the semantically correct numeric type.
 */
const dataRetention = {
	'retention.strategy': defineKv(type("'keep-forever' | 'limit-count'")),
	'retention.maxCount': defineKv(type('number.integer >= 1')),
} as const;

/** User's preferred recording mode — manual trigger vs voice activity detection. */
const recording = {
	'recording.mode': defineKv(type.enumerated(...RECORDING_MODES)),
} as const;

/**
 * Transcription service and per-service model selections.
 *
 * Each service's model is its own KV entry so switching from OpenAI → Groq and
 * back preserves your OpenAI model choice. `temperature` is stored as a number
 * (0–1) — the old settings schema used a string for localStorage.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 2}
 */
const transcription = {
	'transcription.service': defineKv(type.enumerated(...TRANSCRIPTION_SERVICE_IDS)),
	'transcription.openai.model': defineKv(type('string')),
	'transcription.groq.model': defineKv(type('string')),
	'transcription.elevenlabs.model': defineKv(type('string')),
	'transcription.deepgram.model': defineKv(type('string')),
	'transcription.mistral.model': defineKv(type('string')),
	'transcription.language': defineKv(type('string')),
	'transcription.prompt': defineKv(type('string')),
	'transcription.temperature': defineKv(type('0 <= number <= 1')),
	'transcription.compressionEnabled': defineKv(type('boolean')),
	'transcription.compressionOptions': defineKv(type('string')),
} as const;

/** Currently active transformation pipeline. `null` = no transformation selected. */
const transformation = {
	'transformation.selectedId': defineKv(type('string | null')),
} as const;

/** Inference model for transformation completion. OpenRouter model roams across devices. */
const completion = {
	'completion.openrouter.model': defineKv(type('string')),
} as const;

/** Anonymized event logging toggle (Aptabase). */
const analytics = {
	'analytics.enabled': defineKv(type('boolean')),
} as const;

/**
 * In-app keyboard shortcuts. System-global shortcuts are device-specific and stay
 * in localStorage — these are only the shortcuts within the Whispering window.
 * `null` = unbound.
 */
const shortcuts = {
	'shortcut.toggleManualRecording': defineKv(type('string | null')),
	'shortcut.startManualRecording': defineKv(type('string | null')),
	'shortcut.stopManualRecording': defineKv(type('string | null')),
	'shortcut.cancelManualRecording': defineKv(type('string | null')),
	'shortcut.toggleVadRecording': defineKv(type('string | null')),
	'shortcut.startVadRecording': defineKv(type('string | null')),
	'shortcut.stopVadRecording': defineKv(type('string | null')),
	'shortcut.pushToTalk': defineKv(type('string | null')),
	'shortcut.openTransformationPicker': defineKv(type('string | null')),
	'shortcut.runTransformationOnClipboard': defineKv(type('string | null')),
} as const;

/**
 * The Whispering workspace — 5 normalized tables for domain data and ~40 KV entries
 * for synced preferences. Persisted to IndexedDB; future sync extensions will add
 * remote replication.
 */
export default createWorkspace(
	defineWorkspace({
		id: 'whispering',
		tables: {
			recordings,
			transformations,
			transformationSteps,
			transformationRuns,
			transformationStepRuns,
		},
		kv: {
			...sound,
			...output,
			...ui,
			...dataRetention,
			...recording,
			...transcription,
			...transformation,
			...completion,
			...analytics,
			...shortcuts,
		},
	}),
).withExtension('persistence', indexeddbPersistence);
