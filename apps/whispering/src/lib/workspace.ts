import {
	createWorkspace,
	defineKv,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';

// ── Constant imports ─────────────────────────────────────────────────────────

import { ALWAYS_ON_TOP_MODES } from '$lib/constants/ui/always-on-top';
import { LAYOUT_MODES } from '$lib/constants/ui/layout-mode';
import { RECORDING_MODES } from '$lib/constants/audio/recording-modes';
import { OPENAI_INFERENCE_MODELS } from '$lib/constants/inference/openai-models';
import { GROQ_INFERENCE_MODELS } from '$lib/constants/inference/groq-models';
import { ANTHROPIC_INFERENCE_MODELS } from '$lib/constants/inference/anthropic-models';
import { GOOGLE_INFERENCE_MODELS } from '$lib/constants/inference/google-models';
import { OPENAI_TRANSCRIPTION_MODELS } from '$lib/services/isomorphic/transcription/cloud/openai';
import { GROQ_MODELS } from '$lib/services/isomorphic/transcription/cloud/groq';
import { ELEVENLABS_TRANSCRIPTION_MODELS } from '$lib/services/isomorphic/transcription/cloud/elevenlabs';
import { DEEPGRAM_TRANSCRIPTION_MODELS } from '$lib/services/isomorphic/transcription/cloud/deepgram';
import { MISTRAL_TRANSCRIPTION_MODELS } from '$lib/services/isomorphic/transcription/cloud/mistral';

// ── Tables ────────────────────────────────────────────────────────────────────

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

// Shared base fields for all transformation step types
const transformationStepBase = type({
	id: 'string',
	transformationId: 'string',
	order: 'number',
	_v: '1',
});

// Inference provider discriminated union — exact model literals per provider.
// OpenAI/Groq/Anthropic/Google derive from constant arrays; OpenRouter/Custom are free-text.
const inferenceProvider = type.or(
	{
		'inference.provider': "'OpenAI'",
		'inference.model': type.enumerated(...OPENAI_INFERENCE_MODELS),
	},
	{
		'inference.provider': "'Groq'",
		'inference.model': type.enumerated(...GROQ_INFERENCE_MODELS),
	},
	{
		'inference.provider': "'Anthropic'",
		'inference.model': type.enumerated(...ANTHROPIC_INFERENCE_MODELS),
	},
	{
		'inference.provider': "'Google'",
		'inference.model': type.enumerated(...GOOGLE_INFERENCE_MODELS),
	},
	{
		'inference.provider': "'OpenRouter'",
		'inference.model': 'string',
	},
	{
		'inference.provider': "'Custom'",
		'inference.model': 'string',
		'inference.baseUrl': 'string',
	},
);

// Prompt transform: inference provider union merged with prompt-specific fields.
// .merge() distributes — each provider branch gets the prompt fields.
const promptTransformVariant = inferenceProvider.merge({
	type: "'prompt_transform'",
	systemPromptTemplate: 'string',
	userPromptTemplate: 'string',
});

// Find & replace: regex or literal text substitution
const findReplaceVariant = type({
	type: "'find_replace'",
	findText: 'string',
	replaceText: 'string',
	useRegex: 'boolean',
});

// Transformation steps: base merged with discriminated step type union.
// .merge() distributes over the union — each branch gets the base fields.
const transformationSteps = defineTable(
	transformationStepBase.merge(
		type.or(promptTransformVariant, findReplaceVariant),
	),
);

const transformationRuns = defineTable(
	type({
		id: 'string',
		transformationId: 'string',
		recordingId: 'string | null',
		status: "'running' | 'completed' | 'failed'",
		input: 'string',
		output: 'string | null',
		error: 'string | null',
		startedAt: 'string',
		completedAt: 'string | null',
		_v: '1',
	}),
);

const transformationStepRuns = defineTable(
	type({
		id: 'string',
		transformationRunId: 'string',
		stepId: 'string',
		order: 'number',
		status: "'running' | 'completed' | 'failed'",
		input: 'string',
		output: 'string | null',
		error: 'string | null',
		startedAt: 'string',
		completedAt: 'string | null',
		_v: '1',
	}),
);

// ── Synced Settings (KV) ──────────────────────────────────────────────────────
//
// Each setting is its own KV entry with independent last-write-wins resolution.
// This means two devices can change different settings simultaneously without
// one overwriting the other.
//
// Only preferences that roam across devices live here. API keys, filesystem
// paths, hardware device IDs, base URLs, and global shortcuts stay in
// localStorage and are never synced.

// Sound effect toggles — play a sound on these events
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

// Output behavior — what to do after transcription/transformation completes
const output = {
	'transcription.copyToClipboard': defineKv(type('boolean')),
	'transcription.writeToCursor': defineKv(type('boolean')),
	'transcription.simulateEnter': defineKv(type('boolean')),
	'transformation.copyToClipboard': defineKv(type('boolean')),
	'transformation.writeToCursor': defineKv(type('boolean')),
	'transformation.simulateEnter': defineKv(type('boolean')),
} as const;

// UI preferences
const ui = {
	'ui.alwaysOnTop': defineKv(type.enumerated(...ALWAYS_ON_TOP_MODES)),
	'ui.layoutMode': defineKv(type.enumerated(...LAYOUT_MODES)),
} as const;

// Data retention
const dataRetention = {
	'retention.strategy': defineKv(type("'keep-forever' | 'limit-count'")),
	'retention.maxCount': defineKv(type('number.integer >= 1')),
} as const;

// Recording mode (user preference, not hardware-specific)
const recording = {
	'recording.mode': defineKv(type.enumerated(...RECORDING_MODES)),
} as const;

// Transcription service + model selection as a discriminated union.
// Cloud services derive model enums from their constant arrays.
// Local/self-hosted services omit model (paths and IDs are device-specific,
// stay in localStorage).
const transcriptionConfig = type.or(
	{
		service: "'OpenAI'",
		model: type.enumerated(...OPENAI_TRANSCRIPTION_MODELS.map((m) => m.name)),
	},
	{
		service: "'Groq'",
		model: type.enumerated(...GROQ_MODELS.map((m) => m.name)),
	},
	{
		service: "'ElevenLabs'",
		model: type.enumerated(
			...ELEVENLABS_TRANSCRIPTION_MODELS.map((m) => m.name),
		),
	},
	{
		service: "'Deepgram'",
		model: type.enumerated(
			...DEEPGRAM_TRANSCRIPTION_MODELS.map((m) => m.name),
		),
	},
	{
		service: "'Mistral'",
		model: type.enumerated(
			...MISTRAL_TRANSCRIPTION_MODELS.map((m) => m.name),
		),
	},
	{ service: "'whispercpp'" },
	{ service: "'parakeet'" },
	{ service: "'moonshine'" },
	{ service: "'speaches'" },
);

// Transcription settings — service config is a discriminated union,
// shared preferences (prompt, temperature, etc.) are independent KVs.
const transcription = {
	'transcription.config': defineKv(transcriptionConfig),
	'transcription.language': defineKv(type('string')),
	'transcription.prompt': defineKv(type('string')),
	'transcription.temperature': defineKv(type('0 <= number <= 1')),
	'transcription.compressionEnabled': defineKv(type('boolean')),
	'transcription.compressionOptions': defineKv(type('string')),
} as const;

// Transformation selection
const transformation = {
	'transformation.selectedId': defineKv(type('string | null')),
} as const;

// Analytics
const analytics = {
	'analytics.enabled': defineKv(type('boolean')),
} as const;

// In-app shortcuts (not system-global, safe to sync)
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

// ── Workspace ─────────────────────────────────────────────────────────────────

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
			...analytics,
			...shortcuts,
		},
	}),
).withExtension('persistence', indexeddbPersistence);
