import type { Type } from 'arktype';
import { type } from 'arktype';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, trySync } from 'wellcrafted/result';
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

/**
 * Namespace prefix for all device config localStorage keys.
 *
 * localStorage is shared across the entire origin (all tabs, all code on
 * the same domain), so the prefix prevents collisions between different
 * Whispering modules (e.g., `whispering.workspace.*` vs `whispering.device.*`)
 * and any other code running on the same origin.
 *
 * Also used as a subscription filter in the `storage` event handler—only
 * events whose key starts with this prefix are processed by this module.
 */
const STORAGE_PREFIX = 'whispering.device.';

/** Build the full localStorage key for a device config entry. */
function storageKey(key: string): string {
	return `${STORAGE_PREFIX}${key}`;
}

/** Type guard: narrows a string to `DeviceConfigKey` via runtime `in` check. */
function isDeviceConfigKey(key: string): key is DeviceConfigKey {
	return key in DEVICE_DEFINITIONS;
}

/**
 * Parse a raw JSON string from localStorage against a key's schema.
 *
 * Handles both JSON parsing and schema validation, returning the
 * definition's default value on any failure (malformed JSON, schema
 * mismatch, or null/missing value).
 */
function parseStoredValue<K extends DeviceConfigKey>(
	key: K,
	raw: string | null,
): InferDeviceValue<K> {
	const def = DEVICE_DEFINITIONS[key];
	if (raw === null) return def.defaultValue as InferDeviceValue<K>;

	const { data: parsed, error: parseError } = trySync({
		try: () => JSON.parse(raw) as unknown,
		catch: () => Err('malformed JSON'),
	});
	if (parseError) {
		console.warn(`Invalid device config for "${key}", using default`);
		return def.defaultValue as InferDeviceValue<K>;
	}

	const validated = (def.schema as (data: unknown) => unknown)(parsed);
	if (validated instanceof type.errors) {
		console.warn(
			`Invalid device config for "${key}", using default:`,
			validated.summary,
		);
		return def.defaultValue as InferDeviceValue<K>;
	}
	return validated as InferDeviceValue<K>;
}

/** Read a single key from localStorage and validate it via `parseStoredValue`. */
function readKey<K extends DeviceConfigKey>(key: K): InferDeviceValue<K> {
	return parseStoredValue(key, window.localStorage.getItem(storageKey(key)));
}

// ── Reactive store ───────────────────────────────────────────────────────────

function createDeviceConfig() {
	const map = new SvelteMap<string, unknown>();

	// Initialize SvelteMap from per-key localStorage reads.
	for (const key of Object.keys(DEVICE_DEFINITIONS) as DeviceConfigKey[]) {
		map.set(key, readKey(key));
	}

	// ── Cross-tab sync ────────────────────────────────────────────────────
	// The `storage` event fires when ANOTHER tab on the same origin writes
	// to localStorage. This handler filters events by our namespace prefix
	// and updates only the changed key in the SvelteMap.
	//
	// `e.newValue === null` means the key was deleted (e.g., via DevTools
	// or `localStorage.removeItem`), so we restore the definition default.
	window.addEventListener('storage', (e) => {
		if (!e.key?.startsWith(STORAGE_PREFIX)) return;
		const key = e.key.slice(STORAGE_PREFIX.length);
		if (!isDeviceConfigKey(key)) return;

		map.set(key, parseStoredValue(key, e.newValue));
	});

	// ── Non-storage change detection ──────────────────────────────────────
	// The `storage` event only fires for changes from OTHER tabs. If the
	// user edits localStorage directly in DevTools (same tab), or if another
	// library writes to our keys, we won't hear about it. Re-reading all
	// keys on window focus catches these edge cases.
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
		 * and updates the SvelteMap immediately (optimistic update).
		 *
		 * The localStorage write is best-effort—if it fails (e.g., quota
		 * exceeded), an error notification is shown but the in-memory
		 * SvelteMap still updates so the UI stays responsive.
		 */
		set<K extends DeviceConfigKey>(key: K, value: InferDeviceValue<K>) {
			trySync({
				try: () =>
					window.localStorage.setItem(
						storageKey(key),
						JSON.stringify(value),
					),
				catch: (err) => {
					rpc.notify.error({
						title: 'Error updating device config',
						description: extractErrorMessage(err),
					});
					return Ok(undefined);
				},
			});
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
