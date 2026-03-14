/**
 * One-time migration from the old monolithic `whispering-settings` localStorage
 * blob to the new per-key stores (workspace KV + device config localStorage).
 *
 * Runs automatically on boot. Safe to run multiple times (idempotent).
 * Per-key failure doesn't abort the whole migration.
 *
 * @see specs/20260313T163000-settings-data-migration.md
 */
import {
	type DeviceConfigKey,
	deviceConfig,
} from '$lib/state/device-config.svelte';
import workspace from '$lib/workspace';

const MIGRATION_KEY = 'whispering:settings-migration';
const DEVICE_STORAGE_PREFIX = 'whispering.device.';

// ── Type-safe wrappers for dynamic key writes ────────────────────────────────

type KvSetter = (key: string, value: unknown) => void;
type KvGetter = (key: string) => unknown;
type DeviceSetter = (key: string, value: unknown) => void;

const writeWorkspaceKv = workspace.kv.set as KvSetter;
const readWorkspaceKv = workspace.kv.get as KvGetter;
const writeDeviceConfig = deviceConfig.set as DeviceSetter;

// ── Type conversions ─────────────────────────────────────────────────────────

function toNumber(raw: unknown): number | undefined {
	if (typeof raw === 'number') return raw;
	if (typeof raw === 'string') {
		const n = parseFloat(raw);
		return Number.isNaN(n) ? undefined : n;
	}
	return undefined;
}

function toInteger(raw: unknown): number | undefined {
	if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
	if (typeof raw === 'string') {
		const n = parseInt(raw, 10);
		return Number.isNaN(n) ? undefined : n;
	}
	return undefined;
}

// ── Key mappings ─────────────────────────────────────────────────────────────

type WorkspaceKeyMapping = {
	oldKey: string;
	newKey: string;
	convert?: (raw: unknown) => unknown;
};

type DeviceKeyMapping = {
	oldKey: string;
	newKey: string;
};

/**
 * Maps old `whispering-settings` blob keys to new workspace KV keys.
 * Two keys require type conversion (string → number).
 */
const WORKSPACE_KEY_MAP: readonly WorkspaceKeyMapping[] = [
	// Sound toggles
	{ oldKey: 'sound.playOn.manual-start', newKey: 'sound.manualStart' },
	{ oldKey: 'sound.playOn.manual-stop', newKey: 'sound.manualStop' },
	{ oldKey: 'sound.playOn.manual-cancel', newKey: 'sound.manualCancel' },
	{ oldKey: 'sound.playOn.vad-start', newKey: 'sound.vadStart' },
	{ oldKey: 'sound.playOn.vad-capture', newKey: 'sound.vadCapture' },
	{ oldKey: 'sound.playOn.vad-stop', newKey: 'sound.vadStop' },
	{
		oldKey: 'sound.playOn.transcriptionComplete',
		newKey: 'sound.transcriptionComplete',
	},
	{
		oldKey: 'sound.playOn.transformationComplete',
		newKey: 'sound.transformationComplete',
	},

	// Output behavior
	{
		oldKey: 'transcription.copyToClipboardOnSuccess',
		newKey: 'output.transcription.clipboard',
	},
	{
		oldKey: 'transcription.writeToCursorOnSuccess',
		newKey: 'output.transcription.cursor',
	},
	{
		oldKey: 'transcription.simulateEnterAfterOutput',
		newKey: 'output.transcription.enter',
	},
	{
		oldKey: 'transformation.copyToClipboardOnSuccess',
		newKey: 'output.transformation.clipboard',
	},
	{
		oldKey: 'transformation.writeToCursorOnSuccess',
		newKey: 'output.transformation.cursor',
	},
	{
		oldKey: 'transformation.simulateEnterAfterOutput',
		newKey: 'output.transformation.enter',
	},

	// UI
	{ oldKey: 'system.alwaysOnTop', newKey: 'ui.alwaysOnTop' },
	{ oldKey: 'ui.layoutMode', newKey: 'ui.layoutMode' },

	// Data retention (maxCount: string → number)
	{
		oldKey: 'database.recordingRetentionStrategy',
		newKey: 'retention.strategy',
	},
	{
		oldKey: 'database.maxRecordingCount',
		newKey: 'retention.maxCount',
		convert: toInteger,
	},

	// Recording
	{ oldKey: 'recording.mode', newKey: 'recording.mode' },

	// Transcription (temperature: string → number)
	{
		oldKey: 'transcription.selectedTranscriptionService',
		newKey: 'transcription.service',
	},
	{
		oldKey: 'transcription.openai.model',
		newKey: 'transcription.openai.model',
	},
	{ oldKey: 'transcription.groq.model', newKey: 'transcription.groq.model' },
	{
		oldKey: 'transcription.elevenlabs.model',
		newKey: 'transcription.elevenlabs.model',
	},
	{
		oldKey: 'transcription.deepgram.model',
		newKey: 'transcription.deepgram.model',
	},
	{
		oldKey: 'transcription.mistral.model',
		newKey: 'transcription.mistral.model',
	},
	{ oldKey: 'transcription.outputLanguage', newKey: 'transcription.language' },
	{ oldKey: 'transcription.prompt', newKey: 'transcription.prompt' },
	{
		oldKey: 'transcription.temperature',
		newKey: 'transcription.temperature',
		convert: toNumber,
	},
	{
		oldKey: 'transcription.compressionEnabled',
		newKey: 'transcription.compressionEnabled',
	},
	{
		oldKey: 'transcription.compressionOptions',
		newKey: 'transcription.compressionOptions',
	},

	// Transformation
	{
		oldKey: 'transformations.selectedTransformationId',
		newKey: 'transformation.selectedId',
	},
	{
		oldKey: 'completion.openrouter.model',
		newKey: 'transformation.openrouterModel',
	},

	// Analytics
	{ oldKey: 'analytics.enabled', newKey: 'analytics.enabled' },

	// Local shortcuts
	{
		oldKey: 'shortcuts.local.toggleManualRecording',
		newKey: 'shortcut.toggleManualRecording',
	},
	{
		oldKey: 'shortcuts.local.startManualRecording',
		newKey: 'shortcut.startManualRecording',
	},
	{
		oldKey: 'shortcuts.local.stopManualRecording',
		newKey: 'shortcut.stopManualRecording',
	},
	{
		oldKey: 'shortcuts.local.cancelManualRecording',
		newKey: 'shortcut.cancelManualRecording',
	},
	{
		oldKey: 'shortcuts.local.toggleVadRecording',
		newKey: 'shortcut.toggleVadRecording',
	},
	{
		oldKey: 'shortcuts.local.startVadRecording',
		newKey: 'shortcut.startVadRecording',
	},
	{
		oldKey: 'shortcuts.local.stopVadRecording',
		newKey: 'shortcut.stopVadRecording',
	},
	{ oldKey: 'shortcuts.local.pushToTalk', newKey: 'shortcut.pushToTalk' },
	{
		oldKey: 'shortcuts.local.openTransformationPicker',
		newKey: 'shortcut.openTransformationPicker',
	},
	{
		oldKey: 'shortcuts.local.runTransformationOnClipboard',
		newKey: 'shortcut.runTransformationOnClipboard',
	},
] as const;

/**
 * Maps old blob keys to new device config keys.
 * Device keys are looked up in two blobs with priority:
 *   1. Per-key localStorage (already exists → skip)
 *   2. `whispering-device-config` monolithic blob (from brief interim period)
 *   3. `whispering-settings` original blob
 */
const DEVICE_KEY_MAP: readonly DeviceKeyMapping[] = [
	// API keys
	{ oldKey: 'apiKeys.openai', newKey: 'apiKeys.openai' },
	{ oldKey: 'apiKeys.anthropic', newKey: 'apiKeys.anthropic' },
	{ oldKey: 'apiKeys.groq', newKey: 'apiKeys.groq' },
	{ oldKey: 'apiKeys.google', newKey: 'apiKeys.google' },
	{ oldKey: 'apiKeys.deepgram', newKey: 'apiKeys.deepgram' },
	{ oldKey: 'apiKeys.elevenlabs', newKey: 'apiKeys.elevenlabs' },
	{ oldKey: 'apiKeys.mistral', newKey: 'apiKeys.mistral' },
	{ oldKey: 'apiKeys.openrouter', newKey: 'apiKeys.openrouter' },
	{ oldKey: 'apiKeys.custom', newKey: 'apiKeys.custom' },

	// API endpoints
	{ oldKey: 'apiEndpoints.openai', newKey: 'apiEndpoints.openai' },
	{ oldKey: 'apiEndpoints.groq', newKey: 'apiEndpoints.groq' },

	// Recording hardware
	{ oldKey: 'recording.method', newKey: 'recording.method' },
	{ oldKey: 'recording.cpal.deviceId', newKey: 'recording.cpal.deviceId' },
	{
		oldKey: 'recording.navigator.deviceId',
		newKey: 'recording.navigator.deviceId',
	},
	{ oldKey: 'recording.ffmpeg.deviceId', newKey: 'recording.ffmpeg.deviceId' },
	{
		oldKey: 'recording.navigator.bitrateKbps',
		newKey: 'recording.navigator.bitrateKbps',
	},
	{
		oldKey: 'recording.cpal.outputFolder',
		newKey: 'recording.cpal.outputFolder',
	},
	{ oldKey: 'recording.cpal.sampleRate', newKey: 'recording.cpal.sampleRate' },
	{
		oldKey: 'recording.ffmpeg.globalOptions',
		newKey: 'recording.ffmpeg.globalOptions',
	},
	{
		oldKey: 'recording.ffmpeg.inputOptions',
		newKey: 'recording.ffmpeg.inputOptions',
	},
	{
		oldKey: 'recording.ffmpeg.outputOptions',
		newKey: 'recording.ffmpeg.outputOptions',
	},

	// Local model paths
	{
		oldKey: 'transcription.speaches.baseUrl',
		newKey: 'transcription.speaches.baseUrl',
	},
	{
		oldKey: 'transcription.speaches.modelId',
		newKey: 'transcription.speaches.modelId',
	},
	{
		oldKey: 'transcription.whispercpp.modelPath',
		newKey: 'transcription.whispercpp.modelPath',
	},
	{
		oldKey: 'transcription.parakeet.modelPath',
		newKey: 'transcription.parakeet.modelPath',
	},
	{
		oldKey: 'transcription.moonshine.modelPath',
		newKey: 'transcription.moonshine.modelPath',
	},

	// Self-hosted server URLs
	{ oldKey: 'completion.custom.baseUrl', newKey: 'completion.custom.baseUrl' },

	// Global shortcuts (same key names in old and new)
	{
		oldKey: 'shortcuts.global.toggleManualRecording',
		newKey: 'shortcuts.global.toggleManualRecording',
	},
	{
		oldKey: 'shortcuts.global.startManualRecording',
		newKey: 'shortcuts.global.startManualRecording',
	},
	{
		oldKey: 'shortcuts.global.stopManualRecording',
		newKey: 'shortcuts.global.stopManualRecording',
	},
	{
		oldKey: 'shortcuts.global.cancelManualRecording',
		newKey: 'shortcuts.global.cancelManualRecording',
	},
	{
		oldKey: 'shortcuts.global.toggleVadRecording',
		newKey: 'shortcuts.global.toggleVadRecording',
	},
	{
		oldKey: 'shortcuts.global.startVadRecording',
		newKey: 'shortcuts.global.startVadRecording',
	},
	{
		oldKey: 'shortcuts.global.stopVadRecording',
		newKey: 'shortcuts.global.stopVadRecording',
	},
	{
		oldKey: 'shortcuts.global.pushToTalk',
		newKey: 'shortcuts.global.pushToTalk',
	},
	{
		oldKey: 'shortcuts.global.openTransformationPicker',
		newKey: 'shortcuts.global.openTransformationPicker',
	},
	{
		oldKey: 'shortcuts.global.runTransformationOnClipboard',
		newKey: 'shortcuts.global.runTransformationOnClipboard',
	},
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function tryParseJson(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Check if a workspace KV key still has its default value.
 * Returns true if the key hasn't been explicitly set by the user.
 */
function isWorkspaceKeyAtDefault(key: string): boolean {
	const def = (
		workspace.definitions.kv as Record<string, { defaultValue: unknown }>
	)[key];
	if (!def) return false;
	return readWorkspaceKv(key) === def.defaultValue;
}

/**
 * Check if a device config key already has a value in per-key localStorage.
 * If per-key localStorage has an entry, the user (or a prior migration run)
 * has already set it — don't overwrite.
 */
function hasDeviceKeyInStorage(key: string): boolean {
	return window.localStorage.getItem(`${DEVICE_STORAGE_PREFIX}${key}`) !== null;
}

// ── Migration ────────────────────────────────────────────────────────────────

/**
 * Migrate old settings from the monolithic `whispering-settings` localStorage
 * blob to per-key workspace KV and device config stores.
 *
 * **Must be called after workspace and device-config are initialized.**
 * Awaits `workspace.whenReady` internally to ensure IndexedDB persistence
 * has loaded before checking first-write-wins conditions.
 *
 * Silent, automatic, idempotent. One bad key doesn't abort the migration.
 */
export async function migrateOldSettings(): Promise<void> {
	// Already completed or not needed — fast path
	const state = window.localStorage.getItem(MIGRATION_KEY);
	if (state === 'completed' || state === 'not-needed') return;

	// Read old blobs before any async work
	const oldSettingsRaw = window.localStorage.getItem('whispering-settings');
	const oldDeviceConfigRaw = window.localStorage.getItem(
		'whispering-device-config',
	);

	// No old data at all — fresh install
	if (!oldSettingsRaw && !oldDeviceConfigRaw) {
		window.localStorage.setItem(MIGRATION_KEY, 'not-needed');
		return;
	}

	// Parse old blobs
	const oldSettings = tryParseJson(oldSettingsRaw);
	const oldDeviceConfig = tryParseJson(oldDeviceConfigRaw);

	// Both parse failures — nothing to migrate
	if (!oldSettings && !oldDeviceConfig) {
		window.localStorage.setItem(MIGRATION_KEY, 'completed');
		return;
	}

	// Wait for IndexedDB persistence to load so workspace.kv.get() returns
	// real persisted values (not defaults). This ensures the first-write-wins
	// check correctly detects user-set values.
	await workspace.whenReady;

	// ── Migrate workspace keys ───────────────────────────────────────────

	for (const { oldKey, newKey, convert } of WORKSPACE_KEY_MAP) {
		try {
			const raw = oldSettings?.[oldKey];
			if (raw === undefined || raw === null) continue;

			// First-write-wins: skip if user already changed this setting
			if (!isWorkspaceKeyAtDefault(newKey)) continue;

			const value = convert ? convert(raw) : raw;
			if (value === undefined) continue;

			writeWorkspaceKv(newKey, value);
		} catch (err) {
			console.warn(
				`[settings-migration] Failed to migrate workspace key "${oldKey}":`,
				err,
			);
		}
	}

	// ── Migrate device keys ──────────────────────────────────────────────
	// Priority: per-key localStorage > whispering-device-config > whispering-settings

	for (const { oldKey, newKey } of DEVICE_KEY_MAP) {
		try {
			// Already has a per-key entry — user-set or prior migration run
			if (hasDeviceKeyInStorage(newKey)) continue;

			// Look up from monolithic device-config blob first (uses NEW key names),
			// then fall back to the original settings blob (uses OLD key names)
			const raw = oldDeviceConfig?.[newKey] ?? oldSettings?.[oldKey];
			if (raw === undefined || raw === null) continue;

			writeDeviceConfig(newKey as DeviceConfigKey, raw);
		} catch (err) {
			console.warn(
				`[settings-migration] Failed to migrate device key "${oldKey}":`,
				err,
			);
		}
	}

	// ── Cleanup ──────────────────────────────────────────────────────────

	window.localStorage.removeItem('whispering-settings');
	window.localStorage.removeItem('whispering-device-config');
	window.localStorage.setItem(MIGRATION_KEY, 'completed');
}
