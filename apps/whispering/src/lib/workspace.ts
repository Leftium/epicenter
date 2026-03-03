import {
	createWorkspace,
	defineKv,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';

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

const transformationSteps = defineTable(
	type({
		id: 'string',
		transformationId: 'string',
		order: 'number',
		type: "'prompt_transform' | 'find_replace'",
		'prompt_transform.inference.provider':
			"'OpenAI' | 'Groq' | 'Anthropic' | 'Google' | 'OpenRouter' | 'Custom'",
		'prompt_transform.inference.provider.OpenAI.model': 'string',
		'prompt_transform.inference.provider.Groq.model': 'string',
		'prompt_transform.inference.provider.Anthropic.model': 'string',
		'prompt_transform.inference.provider.Google.model': 'string',
		'prompt_transform.inference.provider.OpenRouter.model': 'string',
		'prompt_transform.inference.provider.Custom.model': 'string',
		'prompt_transform.inference.provider.Custom.baseUrl': 'string',
		'prompt_transform.systemPromptTemplate': 'string',
		'prompt_transform.userPromptTemplate': 'string',
		'find_replace.findText': 'string',
		'find_replace.replaceText': 'string',
		'find_replace.useRegex': 'boolean',
		_v: '1',
	}),
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
	'ui.alwaysOnTop': defineKv(type("'Never' | 'Always' | 'While Recording'")),
	'ui.layoutMode': defineKv(type("'sidebar' | 'nav-items'")),
} as const;

// Data retention
const dataRetention = {
	'retention.strategy': defineKv(type("'keep-forever' | 'limit-count'")),
	'retention.maxCount': defineKv(type('number.integer >= 1')),
} as const;

// Recording mode (user preference, not hardware-specific)
const recording = {
	'recording.mode': defineKv(type("'manual' | 'vad'")),
} as const;

// Transcription service & model selections (API keys do NOT sync)
const transcription = {
	'transcription.service': defineKv(type('string')),
	'transcription.language': defineKv(type('string')),
	'transcription.prompt': defineKv(type('string')),
	'transcription.temperature': defineKv(type('0 <= number <= 1')),
	'transcription.compressionEnabled': defineKv(type('boolean')),
	'transcription.compressionOptions': defineKv(type('string')),
	'transcription.model.openai': defineKv(type('string')),
	'transcription.model.elevenlabs': defineKv(type('string')),
	'transcription.model.groq': defineKv(type('string')),
	'transcription.model.deepgram': defineKv(type('string')),
	'transcription.model.mistral': defineKv(type('string')),
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
