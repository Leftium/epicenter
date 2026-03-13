import { createPersistedState } from '@epicenter/svelte-utils';
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

/**
 * Device-bound configuration — secrets, hardware IDs, filesystem paths,
 * and global OS shortcuts that should NEVER sync across devices.
 *
 * Uses createPersistedState (localStorage) with cross-tab sync via
 * storage events. Separate from workspace-settings which syncs via Yjs.
 */
const DeviceConfig = type({
	// ── API keys (secrets, never synced) ──────────────────────────────
	'apiKeys.openai': "string = ''",
	'apiKeys.anthropic': "string = ''",
	'apiKeys.groq': "string = ''",
	'apiKeys.google': "string = ''",
	'apiKeys.deepgram': "string = ''",
	'apiKeys.elevenlabs': "string = ''",
	'apiKeys.mistral': "string = ''",
	'apiKeys.openrouter': "string = ''",
	'apiKeys.custom': "string = ''",

	// ── API endpoint overrides ────────────────────────────────────────
	'apiEndpoints.openai': "string = ''",
	'apiEndpoints.groq': "string = ''",

	// ── Recording hardware ────────────────────────────────────────────
	'recording.method': "'cpal' | 'navigator' | 'ffmpeg' = 'cpal'",
	'recording.cpal.deviceId': 'string | null = null',
	'recording.navigator.deviceId': 'string | null = null',
	'recording.ffmpeg.deviceId': 'string | null = null',
	'recording.navigator.bitrateKbps': type
		.enumerated(...BITRATES_KBPS)
		.default(DEFAULT_BITRATE_KBPS),
	'recording.cpal.outputFolder': 'string | null = null',
	'recording.cpal.sampleRate': "'16000' | '44100' | '48000' = '16000'",
	'recording.ffmpeg.globalOptions': type('string').default(
		FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	),
	'recording.ffmpeg.inputOptions': type('string').default(
		FFMPEG_DEFAULT_INPUT_OPTIONS,
	),
	'recording.ffmpeg.outputOptions': type('string').default(
		FFMPEG_DEFAULT_OUTPUT_OPTIONS,
	),

	// ── Local model paths ─────────────────────────────────────────────
	'transcription.speaches.baseUrl': "string = 'http://localhost:8000'",
	'transcription.speaches.modelId': type('string').default(
		'Systran/faster-distil-whisper-small.en',
	),
	'transcription.whispercpp.modelPath': "string = ''",
	'transcription.parakeet.modelPath': "string = ''",
	'transcription.moonshine.modelPath': "string = ''",

	// ── Self-hosted server URLs ───────────────────────────────────────
	'completion.custom.baseUrl': "string = 'http://localhost:11434/v1'",

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	'shortcuts.global.toggleManualRecording': type('string | null').default(
		`${CommandOrControl}+Shift+;`,
	),
	'shortcuts.global.startManualRecording': 'string | null = null',
	'shortcuts.global.stopManualRecording': 'string | null = null',
	'shortcuts.global.cancelManualRecording': type('string | null').default(
		`${CommandOrControl}+Shift+'`,
	),
	'shortcuts.global.toggleVadRecording': 'string | null = null',
	'shortcuts.global.startVadRecording': 'string | null = null',
	'shortcuts.global.stopVadRecording': 'string | null = null',
	'shortcuts.global.pushToTalk': type('string | null').default(
		`${CommandOrAlt}+Shift+D`,
	),
	'shortcuts.global.openTransformationPicker': type('string | null').default(
		`${CommandOrControl}+Shift+X`,
	),
	'shortcuts.global.runTransformationOnClipboard': type(
		'string | null',
	).default(`${CommandOrControl}+Shift+R`),
});

type DeviceConfig = typeof DeviceConfig.infer;

function getDefaultDeviceConfig(): DeviceConfig {
	const result = DeviceConfig({});
	if (result instanceof type.errors) {
		throw new Error(`Failed to get default device config: ${result.summary}`);
	}
	return result;
}

function parseStoredDeviceConfig(storedValue: unknown): DeviceConfig {
	const fullResult = DeviceConfig(storedValue);
	if (!(fullResult instanceof type.errors)) return fullResult;

	if (typeof storedValue !== 'object' || storedValue === null) {
		return getDefaultDeviceConfig();
	}

	const defaults = getDefaultDeviceConfig();
	const validatedConfig: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(
		storedValue as Record<string, unknown>,
	)) {
		if (key in defaults) {
			validatedConfig[key] = value;
		}
	}

	const merged = { ...defaults, ...validatedConfig };
	const mergedResult = DeviceConfig(merged);
	if (!(mergedResult instanceof type.errors)) return mergedResult;

	const keyByKey: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(validatedConfig)) {
		const test = DeviceConfig({ ...defaults, [key]: value });
		if (!(test instanceof type.errors)) {
			keyByKey[key] = value;
		}
	}

	const finalResult = DeviceConfig({ ...defaults, ...keyByKey });
	if (!(finalResult instanceof type.errors)) return finalResult;

	return defaults;
}

export const deviceConfig = (() => {
	const _config = createPersistedState({
		key: 'whispering-device-config',
		schema: DeviceConfig,
		onParseError: (error) => {
			if (error.type === 'storage_empty') return getDefaultDeviceConfig();
			if (error.type === 'json_parse_error') {
				console.error('Failed to parse device config JSON:', error.error);
				return getDefaultDeviceConfig();
			}
			if (error.type === 'schema_validation_failed') {
				return parseStoredDeviceConfig(error.value);
			}
			if (error.type === 'schema_validation_async_during_sync') {
				console.warn('Unexpected async validation for device config');
				return parseStoredDeviceConfig(error.value);
			}
			return getDefaultDeviceConfig();
		},
		onUpdateError: (err) => {
			rpc.notify.error({
				title: 'Error updating device config',
				description: extractErrorMessage(err),
			});
		},
	});

	return {
		/** Read-only access to current device config values */
		get value(): DeviceConfig {
			return _config.value;
		},

		/** Update multiple device config keys at once */
		update(updates: Partial<DeviceConfig>) {
			_config.value = { ..._config.value, ...updates };
		},

		/** Update a single device config key */
		updateKey<K extends keyof DeviceConfig>(key: K, value: DeviceConfig[K]) {
			_config.value = { ..._config.value, [key]: value };
		},
	};
})();
