import {
	createPersistedMap,
	type PersistedMapInstance,
} from '@epicenter/svelte';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { BITRATES_KBPS, DEFAULT_BITRATE_KBPS } from '$lib/constants/audio';
import { CommandOrAlt, CommandOrControl } from '$lib/constants/keyboard';
import { rpc } from '$lib/query';
import {
	FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	FFMPEG_DEFAULT_INPUT_OPTIONS,
	FFMPEG_DEFAULT_OUTPUT_OPTIONS,
} from '$lib/services/desktop/recorder/ffmpeg';

// ── Per-key definitions ──────────────────────────────────────────────────────

/**
 * Device-bound configuration definitions — secrets, hardware IDs, filesystem
 * paths, and global OS shortcuts that should NEVER sync across devices.
 *
 * Each key has its own schema and default value. Stored individually in
 * localStorage under the `whispering.device.{key}` prefix.
 */
const DEVICE_DEFINITIONS = {
	// ── API keys (secrets, never synced) ──────────────────────────────
	'apiKeys.openai': { schema: type('string'), defaultValue: '' },
	'apiKeys.anthropic': { schema: type('string'), defaultValue: '' },
	'apiKeys.groq': { schema: type('string'), defaultValue: '' },
	'apiKeys.google': { schema: type('string'), defaultValue: '' },
	'apiKeys.deepgram': { schema: type('string'), defaultValue: '' },
	'apiKeys.elevenlabs': { schema: type('string'), defaultValue: '' },
	'apiKeys.mistral': { schema: type('string'), defaultValue: '' },
	'apiKeys.openrouter': { schema: type('string'), defaultValue: '' },
	'apiKeys.custom': { schema: type('string'), defaultValue: '' },

	// ── API endpoint overrides ────────────────────────────────────────
	'apiEndpoints.openai': { schema: type('string'), defaultValue: '' },
	'apiEndpoints.groq': { schema: type('string'), defaultValue: '' },

	// ── Recording hardware ────────────────────────────────────────────
	'recording.method': {
		schema: type("'cpal' | 'navigator' | 'ffmpeg'"),
		defaultValue: 'cpal' as const,
	},
	'recording.cpal.deviceId': {
		schema: type('string | null'),
		defaultValue: null,
	},
	'recording.navigator.deviceId': {
		schema: type('string | null'),
		defaultValue: null,
	},
	'recording.ffmpeg.deviceId': {
		schema: type('string | null'),
		defaultValue: null,
	},
	'recording.navigator.bitrateKbps': {
		schema: type.enumerated(...BITRATES_KBPS),
		defaultValue: DEFAULT_BITRATE_KBPS,
	},
	'recording.cpal.outputFolder': {
		schema: type('string | null'),
		defaultValue: null,
	},
	'recording.cpal.sampleRate': {
		schema: type("'16000' | '44100' | '48000'"),
		defaultValue: '16000' as const,
	},
	'recording.ffmpeg.globalOptions': {
		schema: type('string'),
		defaultValue: FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	},
	'recording.ffmpeg.inputOptions': {
		schema: type('string'),
		defaultValue: FFMPEG_DEFAULT_INPUT_OPTIONS,
	},
	'recording.ffmpeg.outputOptions': {
		schema: type('string'),
		defaultValue: FFMPEG_DEFAULT_OUTPUT_OPTIONS,
	},

	// ── Local model paths ─────────────────────────────────────────────
	'transcription.speaches.baseUrl': {
		schema: type('string'),
		defaultValue: 'http://localhost:8000',
	},
	'transcription.speaches.modelId': {
		schema: type('string'),
		defaultValue: 'Systran/faster-distil-whisper-small.en',
	},
	'transcription.whispercpp.modelPath': {
		schema: type('string'),
		defaultValue: '',
	},
	'transcription.parakeet.modelPath': {
		schema: type('string'),
		defaultValue: '',
	},
	'transcription.moonshine.modelPath': {
		schema: type('string'),
		defaultValue: '',
	},

	// ── Self-hosted server URLs ───────────────────────────────────────
	'completion.custom.baseUrl': {
		schema: type('string'),
		defaultValue: 'http://localhost:11434/v1',
	},

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	'shortcuts.global.toggleManualRecording': {
		schema: type('string | null'),
		defaultValue: `${CommandOrControl}+Shift+;` as string | null,
	},
	'shortcuts.global.startManualRecording': {
		schema: type('string | null'),
		defaultValue: null as string | null,
	},
	'shortcuts.global.stopManualRecording': {
		schema: type('string | null'),
		defaultValue: null as string | null,
	},
	'shortcuts.global.cancelManualRecording': {
		schema: type('string | null'),
		defaultValue: `${CommandOrControl}+Shift+'` as string | null,
	},
	'shortcuts.global.toggleVadRecording': {
		schema: type('string | null'),
		defaultValue: null as string | null,
	},
	'shortcuts.global.startVadRecording': {
		schema: type('string | null'),
		defaultValue: null as string | null,
	},
	'shortcuts.global.stopVadRecording': {
		schema: type('string | null'),
		defaultValue: null as string | null,
	},
	'shortcuts.global.pushToTalk': {
		schema: type('string | null'),
		defaultValue: `${CommandOrAlt}+Shift+D` as string | null,
	},
	'shortcuts.global.openTransformationPicker': {
		schema: type('string | null'),
		defaultValue: `${CommandOrControl}+Shift+X` as string | null,
	},
	'shortcuts.global.runTransformationOnClipboard': {
		schema: type('string | null'),
		defaultValue: `${CommandOrControl}+Shift+R` as string | null,
	},
};

// ── Types ────────────────────────────────────────────────────────────────────

type DeviceConfigDefs = typeof DEVICE_DEFINITIONS;
export type DeviceConfigKey = keyof DeviceConfigDefs & string;

/** Infer the value type for a device config key from its definition. */
export type InferDeviceValue<K extends DeviceConfigKey> =
	DeviceConfigDefs[K]['defaultValue'];

// ── Singleton ────────────────────────────────────────────────────────────────

export const deviceConfig: PersistedMapInstance<typeof DEVICE_DEFINITIONS> =
	createPersistedMap({
		prefix: 'whispering.device.',
		definitions: DEVICE_DEFINITIONS,
		onError: (key) => {
			console.warn(`Invalid device config for "${key}", using default`);
		},
		onUpdateError: (key, error) => {
			rpc.notify.error({
				title: 'Error updating device config',
				description: extractErrorMessage(error),
			});
		},
	});
