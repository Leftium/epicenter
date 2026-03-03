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

// Shared base fields for all transformation step types
const transformationStepBase = type({
	id: 'string',
	transformationId: 'string',
	order: 'number',
	_v: '1',
});

// Inference provider discriminated union — exact model literals per provider.
// OpenAI/Groq/Anthropic/Google have enum models; OpenRouter/Custom are free-text.
const inferenceProvider = type({
	'inference.provider': "'OpenAI'",
	'inference.model':
		"'gpt-5' | 'gpt-5-mini' | 'gpt-4.1' | 'gpt-4.1-mini' | 'gpt-4.1-nano' | 'gpt-4o' | 'gpt-4o-mini' | 'o3' | 'o3-pro' | 'o3-mini' | 'o4-mini'",
})
	.or({
		'inference.provider': "'Groq'",
		'inference.model':
			"'gemma2-9b-it' | 'llama-3.3-70b-versatile' | 'llama-3.1-8b-instant' | 'deepseek-r1-distill-llama-70b' | 'qwen-qwq-32b'",
	})
	.or({
		'inference.provider': "'Anthropic'",
		'inference.model':
			"'claude-sonnet-4-5' | 'claude-haiku-4-5' | 'claude-opus-4-1' | 'claude-sonnet-4-0' | 'claude-opus-4-0' | 'claude-3-7-sonnet-latest' | 'claude-3-5-haiku-latest'",
	})
	.or({
		'inference.provider': "'Google'",
		'inference.model':
			"'gemini-2.5-pro' | 'gemini-2.5-flash' | 'gemini-2.5-flash-lite-preview-06-17' | 'gemini-pro-latest' | 'gemini-flash-latest' | 'gemini-flash-lite-latest'",
	})
	.or({
		'inference.provider': "'OpenRouter'",
		'inference.model': 'string',
	})
	.or({
		'inference.provider': "'Custom'",
		'inference.model': 'string',
		'inference.baseUrl': 'string',
	});

// Prompt transform: LLM completion with provider selection + prompt templates
const promptTransformStep = transformationStepBase
	.and({ type: "'prompt_transform'" })
	.and(inferenceProvider)
	.and({
		systemPromptTemplate: 'string',
		userPromptTemplate: 'string',
	});

// Find & replace: regex or literal text substitution
const findReplaceStep = transformationStepBase.and({
	type: "'find_replace'",
	findText: 'string',
	replaceText: 'string',
	useRegex: 'boolean',
});

const transformationSteps = defineTable(promptTransformStep.or(findReplaceStep));

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
	'ui.alwaysOnTop': defineKv(
		type("'Never' | 'Always' | 'When Recording' | 'When Recording and Transcribing'"),
	),
	'ui.layoutMode': defineKv(type("'sidebar' | 'nav-items'")),
} as const;

// Data retention
const dataRetention = {
	'retention.strategy': defineKv(type("'keep-forever' | 'limit-count'")),
	'retention.maxCount': defineKv(type('number.integer >= 1')),
} as const;

// Recording mode (user preference, not hardware-specific)
const recording = {
	'recording.mode': defineKv(type("'manual' | 'vad' | 'upload'")),
} as const;

// Transcription service + model selection as a discriminated union.
// Cloud services include model (syncs across devices). Local/self-hosted
// services omit model (paths and IDs are device-specific, stay in localStorage).
const transcriptionConfig = type({
	service: "'OpenAI'",
	model: "'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe'",
})
	.or({
		service: "'Groq'",
		model: "'whisper-large-v3' | 'whisper-large-v3-turbo'",
	})
	.or({
		service: "'ElevenLabs'",
		model: "'scribe_v2' | 'scribe_v1' | 'scribe_v1_experimental'",
	})
	.or({
		service: "'Deepgram'",
		model: "'nova-3' | 'nova-2' | 'nova' | 'enhanced' | 'base'",
	})
	.or({
		service: "'Mistral'",
		model: "'voxtral-mini-latest' | 'voxtral-small-latest'",
	})
	.or({ service: "'whispercpp'" })
	.or({ service: "'parakeet'" })
	.or({ service: "'moonshine'" })
	.or({ service: "'speaches'" });

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
