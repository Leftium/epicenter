import { createWorkspace, defineWorkspace, defineTable, defineKv } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';

const recordings = defineTable(type({
	id: 'string',
	title: 'string',
	subtitle: 'string',
	timestamp: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	transcribedText: 'string',
	transcriptionStatus: "'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'",
	_v: '1',
}));

const transformations = defineTable(type({
	id: 'string',
	title: 'string',
	description: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	_v: '1',
}));

const transformationSteps = defineTable(type({
	id: 'string',
	transformationId: 'string',
	order: 'number',
	type: "'prompt_transform' | 'find_replace'",
	'prompt_transform.inference.provider': "'OpenAI' | 'Groq' | 'Anthropic' | 'Google' | 'OpenRouter' | 'Custom'",
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
}));

const transformationRuns = defineTable(type({
	id: 'string',
	transformationId: 'string',
	'recordingId': 'string | null',
	status: "'running' | 'completed' | 'failed'",
	input: 'string',
	'output': 'string | null',
	'error': 'string | null',
	startedAt: 'string',
	'completedAt': 'string | null',
	_v: '1',
}));

const transformationStepRuns = defineTable(type({
	id: 'string',
	transformationRunId: 'string',
	stepId: 'string',
	order: 'number',
	status: "'running' | 'completed' | 'failed'",
	input: 'string',
	'output': 'string | null',
	'error': 'string | null',
	startedAt: 'string',
	'completedAt': 'string | null',
	_v: '1',
}));

const syncedSettings = defineKv(type({
	// Sound effect toggles
	'sound.playOn.manual-start': 'boolean',
	'sound.playOn.manual-stop': 'boolean',
	'sound.playOn.manual-cancel': 'boolean',
	'sound.playOn.vad-start': 'boolean',
	'sound.playOn.vad-capture': 'boolean',
	'sound.playOn.vad-stop': 'boolean',
	'sound.playOn.transcriptionComplete': 'boolean',
	'sound.playOn.transformationComplete': 'boolean',

	// Output behavior
	'transcription.copyToClipboardOnSuccess': 'boolean',
	'transcription.writeToCursorOnSuccess': 'boolean',
	'transcription.simulateEnterAfterOutput': 'boolean',
	'transformation.copyToClipboardOnSuccess': 'boolean',
	'transformation.writeToCursorOnSuccess': 'boolean',
	'transformation.simulateEnterAfterOutput': 'boolean',

	// UI
	'system.alwaysOnTop': "'Never' | 'Always' | 'While Recording'",
	'ui.layoutMode': "'sidebar' | 'nav-items'",

	// Data retention
	'database.recordingRetentionStrategy': "'keep-forever' | 'limit-count'",
	'database.maxRecordingCount': 'string',

	// Recording mode (user preference, not hardware-specific)
	'recording.mode': "'manual' | 'vad'",

	// Transcription service & model selections (API key does NOT sync)
	'transcription.selectedTranscriptionService': 'string',
	'transcription.outputLanguage': 'string',
	'transcription.prompt': 'string',
	'transcription.temperature': 'string',
	'transcription.compressionEnabled': 'boolean',
	'transcription.compressionOptions': 'string',
	'transcription.openai.model': 'string',
	'transcription.elevenlabs.model': 'string',
	'transcription.groq.model': 'string',
	'transcription.deepgram.model': 'string',
	'transcription.mistral.model': 'string',

	// Transformation selection
	'transformations.selectedTransformationId': 'string | null',

	// Analytics
	'analytics.enabled': 'boolean',

	// In-app shortcuts (not system-global, safe to sync)
	'shortcuts.local.toggleManualRecording': 'string | null',
	'shortcuts.local.startManualRecording': 'string | null',
	'shortcuts.local.stopManualRecording': 'string | null',
	'shortcuts.local.cancelManualRecording': 'string | null',
	'shortcuts.local.toggleVadRecording': 'string | null',
	'shortcuts.local.startVadRecording': 'string | null',
	'shortcuts.local.stopVadRecording': 'string | null',
	'shortcuts.local.pushToTalk': 'string | null',
	'shortcuts.local.openTransformationPicker': 'string | null',
	'shortcuts.local.runTransformationOnClipboard': 'string | null',
}));

export default createWorkspace(defineWorkspace({
	id: 'whispering',
	tables: {
		recordings,
		transformations,
		transformationSteps,
		transformationRuns,
		transformationStepRuns,
	},
	kv: { syncedSettings },
})).withExtension('persistence', indexeddbPersistence);
