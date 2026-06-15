import { RecorderError } from './types';

/**
 * Inspect a raw recorder-related error cause and, if it matches a known
 * permission-denied or no-input-device pattern, return the typed RecorderError
 * variant (already wrapped in Err). Callers fall back to a generic variant
 * (InitFailed, StartFailed, StreamAcquisition, etc.) when this returns null.
 *
 * Mirrors the raw permission-denied and no-input-device string patterns that
 * cpal emits on the Rust side, and also handles browser DOMException names
 * from getUserMedia and wellcrafted tagged errors from device-stream. The
 * string patterns matched below are the real contract.
 *
 * Inspired by Handy (MIT licensed):
 * https://github.com/cjpais/Handy/blob/main/src-tauri/src/audio_toolkit/audio/recorder.rs
 */
export function categorizeRecorderError(cause: unknown) {
	// wellcrafted tagged errors (e.g. DeviceStreamError) expose a `name` field.
	if (cause && typeof cause === 'object' && 'name' in cause) {
		const name = (cause as { name: unknown }).name;
		// Browser: getUserMedia DOMException codes.
		if (name === 'NotAllowedError' || name === 'SecurityError') {
			return RecorderError.MicrophonePermissionDenied({ cause });
		}
		if (name === 'NotFoundError' || name === 'OverconstrainedError') {
			return RecorderError.NoInputDevice({ cause });
		}
		// device-stream's own tag (we re-categorize so the toast layer can
		// branch on RecorderError variants without importing DeviceStreamError).
		if (name === 'PermissionDenied') {
			return RecorderError.MicrophonePermissionDenied({ cause });
		}
		if (name === 'NoDevicesFound') {
			return RecorderError.NoInputDevice({ cause });
		}
	}

	// Rust returns errors as plain strings via Tauri invoke. String-match the
	// same patterns the Rust-side helpers do so JS callers get typed variants.
	const message = extractMessageString(cause);
	if (!message) return null;
	const normalized = message.toLowerCase();

	if (
		normalized.includes('access is denied') ||
		normalized.includes('permission denied') ||
		// Windows WASAPI HRESULT E_ACCESSDENIED.
		normalized.includes('0x80070005')
	) {
		return RecorderError.MicrophonePermissionDenied({ cause });
	}

	if (
		normalized.includes('no input device found') ||
		normalized.includes('no default input device available') ||
		(normalized.includes('failed to fetch preferred config') &&
			normalized.includes('coreaudio'))
	) {
		return RecorderError.NoInputDevice({ cause });
	}

	return null;
}

function extractMessageString(cause: unknown): string | null {
	if (typeof cause === 'string') return cause;
	if (cause && typeof cause === 'object' && 'message' in cause) {
		const message = (cause as { message: unknown }).message;
		if (typeof message === 'string') return message;
	}
	return null;
}
