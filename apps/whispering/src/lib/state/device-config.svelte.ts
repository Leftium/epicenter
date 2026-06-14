import { createPersistedMap, defineEntry } from '@epicenter/svelte';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { os } from '#platform/os';
import { BITRATES_KBPS, DEFAULT_BITRATE_KBPS } from '$lib/constants/audio';
import { LOCAL_MODEL_UNLOAD_POLICIES } from '$lib/constants/local-model-unload-policy';
import { log, report } from '$lib/report';
import type { KeyBinding } from '$lib/tauri/commands';

// ── Global shortcut binding shape ────────────────────────────────────────────

/**
 * Runtime shape of a stored global shortcut: the structured `KeyBinding` the
 * desktop rdev backend matches on (physical-key space). `modifiers` is strictly
 * enumerated; `keys` is validated as strings here and against the real `Key`
 * vocabulary by Rust at the IPC boundary (so a bad key is rejected on register,
 * not silently stored as garbage).
 */
const globalBinding = type({
	modifiers: "('ctrl' | 'alt' | 'shift' | 'meta' | 'fn')[]",
	keys: 'string[]',
}).or('null');

// Default bindings, platform-resolved (Command on macOS, Control/Alt elsewhere),
// matching the spirit of the old accelerator defaults. Exported so the reset
// path in register-commands shares this one source of truth.
const PRIMARY: KeyBinding['modifiers'][number] = os.isApple ? 'meta' : 'ctrl';
const PUSH_TO_TALK: KeyBinding['modifiers'][number] = os.isApple
	? 'meta'
	: 'alt';

export const DEFAULT_GLOBAL_BINDINGS = {
	pushToTalk: { modifiers: [PUSH_TO_TALK, 'shift'], keys: ['keyD'] },
	toggleManualRecording: { modifiers: [PRIMARY, 'shift'], keys: ['semiColon'] },
	cancelManualRecording: { modifiers: [PRIMARY, 'shift'], keys: ['quote'] },
	toggleVadRecording: null,
	openTransformationPicker: { modifiers: [PRIMARY, 'shift'], keys: ['keyX'] },
	runTransformationOnClipboard: {
		modifiers: [PRIMARY, 'shift'],
		keys: ['keyR'],
	},
} satisfies Record<string, KeyBinding | null>;

// ── Per-key definitions ──────────────────────────────────────────────────────

/**
 * Device-bound configuration definitions: secrets, hardware IDs, filesystem
 * paths, and global OS shortcuts that should NEVER sync across devices.
 *
 * Each key has its own schema and default value. Stored individually in
 * localStorage under the `whispering.device.{key}` prefix.
 */
const DEVICE_DEFINITIONS = {
	// ── Provider backends ─────────────────────────────────────────────
	// One record per network backend: how this device reaches it.
	// API keys are secrets and never sync. Empty `endpoint` means the
	// provider's official API; Custom and Speaches have no official API,
	// so their endpoints carry real defaults.
	'providers.openai.apiKey': defineEntry(type('string'), ''),
	'providers.anthropic.apiKey': defineEntry(type('string'), ''),
	'providers.groq.apiKey': defineEntry(type('string'), ''),
	'providers.google.apiKey': defineEntry(type('string'), ''),
	'providers.deepgram.apiKey': defineEntry(type('string'), ''),
	'providers.elevenlabs.apiKey': defineEntry(type('string'), ''),
	'providers.mistral.apiKey': defineEntry(type('string'), ''),
	'providers.openrouter.apiKey': defineEntry(type('string'), ''),
	'providers.custom.apiKey': defineEntry(type('string'), ''),
	'providers.openai.endpoint': defineEntry(type('string'), ''),
	'providers.groq.endpoint': defineEntry(type('string'), ''),
	'providers.custom.endpoint': defineEntry(
		type('string'),
		'http://localhost:11434/v1',
	),
	'providers.speaches.endpoint': defineEntry(
		type('string'),
		'http://localhost:8000',
	),
	/**
	 * Model installed on the Speaches server. Device-local like the rest
	 * of the record: which models are pulled depends on the machine.
	 */
	'providers.speaches.modelId': defineEntry(
		type('string'),
		'Systran/faster-distil-whisper-small.en',
	),

	// ── Recording hardware ────────────────────────────────────────────
	'recording.cpal.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.bitrateKbps': defineEntry(
		type.enumerated(...BITRATES_KBPS),
		DEFAULT_BITRATE_KBPS,
	),
	'recording.cpal.sampleRate': defineEntry(
		type("'16000' | '44100' | '48000'"),
		'16000',
	),

	// ── Local model paths ─────────────────────────────────────────────
	/**
	 * The engine's selected model as an entry name inside its models folder
	 * (e.g. "ggml-tiny.bin", "parakeet-tdt-0.6b-v3-int8"), never a path. The
	 * folder under appdata is the single source of truth for where models
	 * live; `$lib/services/transcription/local-model-folder.ts` resolves
	 * names back to paths.
	 */
	'transcription.whispercpp.model': defineEntry(type('string'), ''),
	'transcription.parakeet.model': defineEntry(type('string'), ''),
	'transcription.moonshine.model': defineEntry(type('string'), ''),

	// ── Local model lifecycle (per device: memory pressure is physical) ─
	/**
	 * When to drop the resident local transcription model. Pushed to Rust
	 * on change via the `set_unload_policy` Tauri command; the Rust side
	 * owns the actual eviction (synchronous for `immediately`, idle-watcher
	 * for timed values). Device-local because the right answer depends on
	 * available RAM (a 64 GB workstation and a 16 GB laptop want different
	 * policies for the same workflow).
	 */
	'transcription.localModelUnloadPolicy': defineEntry(
		type.enumerated(...LOCAL_MODEL_UNLOAD_POLICIES),
		'after_5_minutes',
	),

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	// Structured KeyBinding (physical-key space) for the rdev backend. Old
	// accelerator-string values are not migrated: they fail this schema and reset
	// to the defaults (clean break, see the note below the singleton).
	'shortcuts.global.toggleManualRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.toggleManualRecording,
	),
	'shortcuts.global.cancelManualRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.cancelManualRecording,
	),
	'shortcuts.global.toggleVadRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.toggleVadRecording,
	),
	'shortcuts.global.pushToTalk': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.pushToTalk,
	),
	'shortcuts.global.openTransformationPicker': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.openTransformationPicker,
	),
	'shortcuts.global.runTransformationOnClipboard': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.runTransformationOnClipboard,
	),
};

// ── Types ────────────────────────────────────────────────────────────────────

type DeviceConfigDefs = typeof DEVICE_DEFINITIONS;
export type DeviceConfigKey = keyof DeviceConfigDefs & string;

// ── Legacy migration ─────────────────────────────────────────────────────────

const DEVICE_CONFIG_PREFIX = 'whispering.device.';

const LEGACY_LOCAL_MODEL_SELECTIONS = [
	{
		from: 'transcription.whispercpp.modelPath',
		to: 'transcription.whispercpp.model',
	},
	{
		from: 'transcription.parakeet.modelPath',
		to: 'transcription.parakeet.model',
	},
	{
		from: 'transcription.moonshine.modelPath',
		to: 'transcription.moonshine.model',
	},
] as const satisfies readonly {
	from: string;
	to: DeviceConfigKey;
}[];

function modelEntryNameFromLegacyPath(path: string) {
	return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) ?? '';
}

function readLegacyString(key: string) {
	const raw = window.localStorage.getItem(`${DEVICE_CONFIG_PREFIX}${key}`);
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as unknown;
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const deviceConfig = createPersistedMap({
	prefix: DEVICE_CONFIG_PREFIX,
	definitions: DEVICE_DEFINITIONS,
	onError: (key) => {
		log.info(`Invalid device config for "${key}", using default`);
	},
	onUpdateError: (_key, error) => {
		report.error({
			title: 'Error updating device config',
			cause: {
				name: 'DeviceConfigUpdateFailed',
				message: extractErrorMessage(error),
			},
		});
	},
});

for (const migration of LEGACY_LOCAL_MODEL_SELECTIONS) {
	if (deviceConfig.get(migration.to)) continue;
	const legacyPath = readLegacyString(migration.from);
	if (!legacyPath) continue;
	const entryName = modelEntryNameFromLegacyPath(legacyPath);
	if (entryName) deviceConfig.set(migration.to, entryName);
}

// Global shortcuts are NOT migrated from the old accelerator-string format. A
// clean break: a legacy value fails the `globalBinding` schema on read and falls
// back to the default (see `createPersistedMap`), so upgrading users get the new
// defaults. We refuse to carry a parser for a format nothing writes anymore.
