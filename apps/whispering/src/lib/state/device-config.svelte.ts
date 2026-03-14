import type { Type } from 'arktype';
import { type } from 'arktype';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { BITRATES_KBPS, DEFAULT_BITRATE_KBPS } from '$lib/constants/audio';
import { CommandOrAlt, CommandOrControl } from '$lib/constants/keyboard';
import { rpc } from '$lib/query';
import {
	FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	FFMPEG_DEFAULT_INPUT_OPTIONS,
	FFMPEG_DEFAULT_OUTPUT_OPTIONS,
} from '$lib/services/desktop/recorder/ffmpeg';

// ── Definition helper ────────────────────────────────────────────────────────

/**
 * Define a per-key device config entry with schema and default value.
 * Mirrors the `defineKv(schema, defaultValue)` pattern from workspace.
 */
function defineDevice<T>(
	schema: Type<T>,
	defaultValue: NoInfer<T>,
): { schema: Type<T>; defaultValue: T } {
	return { schema, defaultValue };
}

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
	'apiKeys.openai': defineDevice(type('string'), ''),
	'apiKeys.anthropic': defineDevice(type('string'), ''),
	'apiKeys.groq': defineDevice(type('string'), ''),
	'apiKeys.google': defineDevice(type('string'), ''),
	'apiKeys.deepgram': defineDevice(type('string'), ''),
	'apiKeys.elevenlabs': defineDevice(type('string'), ''),
	'apiKeys.mistral': defineDevice(type('string'), ''),
	'apiKeys.openrouter': defineDevice(type('string'), ''),
	'apiKeys.custom': defineDevice(type('string'), ''),

	// ── API endpoint overrides ────────────────────────────────────────
	'apiEndpoints.openai': defineDevice(type('string'), ''),
	'apiEndpoints.groq': defineDevice(type('string'), ''),

	// ── Recording hardware ────────────────────────────────────────────
	'recording.method': defineDevice(
		type("'cpal' | 'navigator' | 'ffmpeg'"),
		'cpal',
	),
	'recording.cpal.deviceId': defineDevice(type('string | null'), null),
	'recording.navigator.deviceId': defineDevice(type('string | null'), null),
	'recording.ffmpeg.deviceId': defineDevice(type('string | null'), null),
	'recording.navigator.bitrateKbps': defineDevice(
		type.enumerated(...BITRATES_KBPS),
		DEFAULT_BITRATE_KBPS,
	),
	'recording.cpal.outputFolder': defineDevice(type('string | null'), null),
	'recording.cpal.sampleRate': defineDevice(
		type("'16000' | '44100' | '48000'"),
		'16000',
	),
	'recording.ffmpeg.globalOptions': defineDevice(
		type('string'),
		FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	),
	'recording.ffmpeg.inputOptions': defineDevice(
		type('string'),
		FFMPEG_DEFAULT_INPUT_OPTIONS,
	),
	'recording.ffmpeg.outputOptions': defineDevice(
		type('string'),
		FFMPEG_DEFAULT_OUTPUT_OPTIONS,
	),

	// ── Local model paths ─────────────────────────────────────────────
	'transcription.speaches.baseUrl': defineDevice(
		type('string'),
		'http://localhost:8000',
	),
	'transcription.speaches.modelId': defineDevice(
		type('string'),
		'Systran/faster-distil-whisper-small.en',
	),
	'transcription.whispercpp.modelPath': defineDevice(type('string'), ''),
	'transcription.parakeet.modelPath': defineDevice(type('string'), ''),
	'transcription.moonshine.modelPath': defineDevice(type('string'), ''),

	// ── Self-hosted server URLs ───────────────────────────────────────
	'completion.custom.baseUrl': defineDevice(
		type('string'),
		'http://localhost:11434/v1',
	),

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	'shortcuts.global.toggleManualRecording': defineDevice(
		type('string | null'),
		`${CommandOrControl}+Shift+;`,
	),
	'shortcuts.global.startManualRecording': defineDevice(
		type('string | null'),
		null,
	),
	'shortcuts.global.stopManualRecording': defineDevice(
		type('string | null'),
		null,
	),
	'shortcuts.global.cancelManualRecording': defineDevice(
		type('string | null'),
		`${CommandOrControl}+Shift+'`,
	),
	'shortcuts.global.toggleVadRecording': defineDevice(
		type('string | null'),
		null,
	),
	'shortcuts.global.startVadRecording': defineDevice(
		type('string | null'),
		null,
	),
	'shortcuts.global.stopVadRecording': defineDevice(
		type('string | null'),
		null,
	),
	'shortcuts.global.pushToTalk': defineDevice(
		type('string | null'),
		`${CommandOrAlt}+Shift+D`,
	),
	'shortcuts.global.openTransformationPicker': defineDevice(
		type('string | null'),
		`${CommandOrControl}+Shift+X`,
	),
	'shortcuts.global.runTransformationOnClipboard': defineDevice(
		type('string | null'),
		`${CommandOrControl}+Shift+R`,
	),
};

// ── Types ────────────────────────────────────────────────────────────────────

type DeviceConfigDefs = typeof DEVICE_DEFINITIONS;
export type DeviceConfigKey = keyof DeviceConfigDefs & string;

/** Infer the value type for a device config key from its definition. */
export type InferDeviceValue<K extends DeviceConfigKey> =
	DeviceConfigDefs[K]['defaultValue'];

// ── Per-key storage ──────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'whispering.device.';

function storageKey(key: string): string {
	return `${STORAGE_PREFIX}${key}`;
}

/**
 * Read a single key from localStorage, validate against its schema,
 * and fall back to the definition's default on any failure.
 */
function readKey<K extends DeviceConfigKey>(key: K): InferDeviceValue<K> {
	const def = DEVICE_DEFINITIONS[key];
	const raw = window.localStorage.getItem(storageKey(key));
	if (raw === null) return def.defaultValue as InferDeviceValue<K>;

	try {
		const parsed: unknown = JSON.parse(raw);
		const result = (def.schema as (data: unknown) => unknown)(parsed);
		if (result instanceof type.errors) {
			console.warn(
				`Invalid device config for "${key}", using default:`,
				result.summary,
			);
			return def.defaultValue as InferDeviceValue<K>;
		}
		return result as InferDeviceValue<K>;
	} catch {
		console.warn(`Failed to parse device config for "${key}", using default`);
		return def.defaultValue as InferDeviceValue<K>;
	}
}

// ── Reactive store ───────────────────────────────────────────────────────────

function createDeviceConfig() {
	const map = new SvelteMap<string, unknown>();

	// Initialize SvelteMap from per-key localStorage reads.
	for (const key of Object.keys(DEVICE_DEFINITIONS) as DeviceConfigKey[]) {
		map.set(key, readKey(key));
	}

	// Cross-tab sync: storage event filtered by prefix.
	// Only the changed key updates in the SvelteMap.
	window.addEventListener('storage', (e) => {
		if (!e.key?.startsWith(STORAGE_PREFIX)) return;
		const key = e.key.slice(STORAGE_PREFIX.length);
		if (!(key in DEVICE_DEFINITIONS)) return;

		const def = DEVICE_DEFINITIONS[key as DeviceConfigKey];

		if (e.newValue === null) {
			map.set(key, def.defaultValue);
			return;
		}

		try {
			const parsed: unknown = JSON.parse(e.newValue);
			const result = (def.schema as (data: unknown) => unknown)(parsed);
			if (result instanceof type.errors) {
				map.set(key, def.defaultValue);
				return;
			}
			map.set(key, result);
		} catch {
			map.set(key, def.defaultValue);
		}
	});

	// Re-read all keys on focus (handles non-storage changes like DevTools edits).
	window.addEventListener('focus', () => {
		for (const key of Object.keys(DEVICE_DEFINITIONS) as DeviceConfigKey[]) {
			map.set(key, readKey(key));
		}
	});

	return {
		/**
		 * Get a device config value. Returns the current value from the
		 * reactive SvelteMap. Components reading this will re-render when
		 * the value changes (from local writes OR cross-tab sync).
		 */
		get<K extends DeviceConfigKey>(key: K): InferDeviceValue<K> {
			return map.get(key) as InferDeviceValue<K>;
		},

		/**
		 * Set a single device config value. Writes to localStorage per-key
		 * and updates the SvelteMap. Components re-render only for this key.
		 */
		set<K extends DeviceConfigKey>(key: K, value: InferDeviceValue<K>) {
			try {
				window.localStorage.setItem(storageKey(key), JSON.stringify(value));
			} catch (err) {
				rpc.notify.error({
					title: 'Error updating device config',
					description: extractErrorMessage(err),
				});
			}
			map.set(key, value);
		},

		/**
		 * Update multiple device config keys at once. Calls set() for each
		 * key. Not atomic — partial writes are fine for device config.
		 */
		update(updates: Partial<{ [K in DeviceConfigKey]: InferDeviceValue<K> }>) {
			for (const [key, value] of Object.entries(updates)) {
				this.set(
					key as DeviceConfigKey,
					value as InferDeviceValue<DeviceConfigKey>,
				);
			}
		},

		/**
		 * Reset all device config to defaults. Writes each default value
		 * to localStorage per-key.
		 */
		reset() {
			for (const key of Object.keys(DEVICE_DEFINITIONS) as DeviceConfigKey[]) {
				this.set(
					key,
					DEVICE_DEFINITIONS[key].defaultValue as InferDeviceValue<typeof key>,
				);
			}
		},

		/**
		 * Get the definition's default value for a key. Useful for showing
		 * "Default: X" placeholders in settings UI without reading localStorage.
		 */
		getDefault<K extends DeviceConfigKey>(key: K): InferDeviceValue<K> {
			return DEVICE_DEFINITIONS[key].defaultValue as InferDeviceValue<K>;
		},
	};
}

export const deviceConfig = createDeviceConfig();
