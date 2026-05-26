import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type {
	CancelRecordingResult,
	WhisperingRecordingState,
} from '$lib/constants/audio';

/**
 * Callback function for providing real-time status updates during multi-step recording operations.
 * These status messages become user-facing toast notifications that provide encouraging progress
 * feedback during recording workflows. The messages are displayed as loading toasts in the UI,
 * helping users understand what's happening during potentially long-running operations.
 *
 * @example
 * ```typescript
 * // Good: User-friendly with emoji and encouraging tone
 * sendStatus({
 *   title: '🎙️ Starting Recording',
 *   description: 'Setting up your microphone...'
 * });
 *
 * sendStatus({
 *   title: '✅ Recording Saved',
 *   description: 'Your recording is ready for transcription!'
 * });
 *
 * // Bad: Technical language, no emoji, not encouraging
 * sendStatus({
 *   title: 'Initializing MediaStream',
 *   description: 'getUserMedia() call in progress'
 * });
 * ```
 */
export type UpdateStatusMessageFn = (args: {
	title: string;
	description: string;
}) => void;

/**
 * Device acquisition outcome after attempting to connect to a recording device.
 *
 * This type represents the result of device selection during recording startup.
 * All outcomes include the deviceId that was ultimately used for recording.
 * When the outcome is 'fallback', appropriate status messages are automatically
 * sent via UpdateStatusMessageFn to inform users about device switching.
 *
 * @example
 * ```typescript
 * // Success: User's preferred device worked
 * { outcome: 'success', deviceId: 'preferred-device-id' as DeviceIdentifier }
 *
 * // Fallback: No device selected, used default
 * // Status message: "🔍 No Device Selected" -> "Using your default microphone instead"
 * {
 *   outcome: 'fallback',
 *   reason: 'no-device-selected',
 *   deviceId: 'default' as DeviceIdentifier
 * }
 *
 * // Fallback: Preferred device unavailable, used alternative
 * // Status message: "⚠️ Finding a New Microphone" -> "Using MacBook Pro Microphone instead"
 * {
 *   outcome: 'fallback',
 *   reason: 'preferred-device-unavailable',
 *   deviceId: 'MacBook Pro Microphone' as DeviceIdentifier
 * }
 * ```
 */
export type DeviceAcquisitionOutcome =
	| {
			outcome: 'success';
			deviceId: DeviceIdentifier;
	  }
	| {
			outcome: 'fallback';
			reason: 'no-device-selected' | 'preferred-device-unavailable';
			deviceId: DeviceIdentifier;
	  };

/**
 * Platform-agnostic device identifier for audio recording devices.
 *
 * On Web (Navigator API):
 *   - This is the unique `deviceId` from MediaDeviceInfo (e.g., "default" or a GUID)
 *   - NOT the device label. We use the actual deviceId for uniqueness
 *
 * On Desktop (CPAL):
 *   - This is the device name as a string (e.g., "MacBook Pro Microphone")
 *   - The name serves as both identifier and label
 *
 * While these represent different concepts on each platform, they serve the same
 * purpose: uniquely identifying a recording device for selection and persistence.
 * The branded type ensures type safety and makes the dual nature explicit.
 *
 * @example
 * // Web: Stores the deviceId (unique identifier, NOT the label)
 * const deviceIdentifier: DeviceIdentifier = "8a7b9c..." as DeviceIdentifier;
 *
 * // Desktop: Stores the device name (which is both ID and label)
 * const deviceIdentifier: DeviceIdentifier = "MacBook Pro Microphone" as DeviceIdentifier;
 */
export type DeviceIdentifier = string & Brand<'DeviceIdentifier'>;

/**
 * Represents an audio recording device with both a unique identifier and human-readable label.
 *
 * On Web (Navigator API):
 *   - `id`: The unique deviceId from MediaDeviceInfo (e.g., "default" or a GUID)
 *   - `label`: The human-readable device label (e.g., "Built-in Microphone")
 *
 * On Desktop (CPAL):
 *   - `id`: The device name (e.g., "MacBook Pro Microphone")
 *   - `label`: The same device name (identical to id for desktop)
 *
 * This separation allows for better UX (showing readable names) while maintaining
 * stable identifiers for settings persistence.
 *
 * @example
 * // Web device
 * const device: Device = {
 *   id: "8a7b9c..." as DeviceIdentifier,
 *   label: "Blue Yeti USB Microphone"
 * };
 *
 * // Desktop device
 * const device: Device = {
 *   id: "MacBook Pro Microphone" as DeviceIdentifier,
 *   label: "MacBook Pro Microphone"
 * };
 */
export type Device = {
	id: DeviceIdentifier;
	label: string;
};

/**
 * Type guard to convert a string to DeviceIdentifier
 * Use this when receiving device identifiers from external sources
 * @see DeviceIdentifier
 */
export function asDeviceIdentifier(value: string): DeviceIdentifier {
	return value as DeviceIdentifier;
}

export const RecorderError = defineErrors({
	EnumerateDevices: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate recording devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
	NoDevice: ({ message }: { message: string }) => ({
		message,
	}),
	MicrophonePermissionDenied: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			'Microphone access was denied. Please grant microphone permission in your system or browser settings and try again.',
		cause,
	}),
	NoInputDevice: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			"We couldn't find any microphone to record from. Please connect a microphone and try again.",
		cause,
	}),
	AlreadyRecording: () => ({
		message:
			'A recording is already in progress. Please stop the current recording before starting a new one.',
	}),
	InitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to initialize the audio recorder: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StartFailed: ({ cause }: { cause: unknown }) => ({
		message: `Unable to start recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StopFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to stop recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StreamAcquisition: ({ cause }: { cause: unknown }) => ({
		message: `Failed to acquire recording stream: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ReadFileFailed: ({ cause }: { cause: unknown }) => ({
		message: `Unable to read recording file: ${extractErrorMessage(cause)}`,
		cause,
	}),
	GetStateFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to get recorder state: ${extractErrorMessage(cause)}`,
		cause,
	}),
	InvokeFailed: ({ command, cause }: { command: string; cause: unknown }) => ({
		message: `Tauri invoke '${command}' failed: ${extractErrorMessage(cause)}`,
		command,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;

/**
 * Base parameters shared across all methods
 */
type BaseRecordingParams = {
	selectedDeviceId: DeviceIdentifier | null;
	recordingId: string;
};

/**
 * CPAL (native Rust) recording parameters
 */
export type CpalRecordingParams = BaseRecordingParams & {
	method: 'cpal';
	sampleRate: string;
};

/**
 * Navigator (MediaRecorder) recording parameters
 */
export type NavigatorRecordingParams = BaseRecordingParams & {
	method: 'navigator';
	bitrateKbps: string;
};

/**
 * Canonical audio artifact emitted by every recorder path.
 * Describes only the audio payload. Capture-session metadata such as
 * `recordingId` and `durationMs` belongs to the `Recording.stop()` result.
 *
 * Two variants only:
 * - `pcm`: in-memory mono PCM @ 16 kHz from the cpal recorder. Cheapest
 *   input for both cloud (direct opus encode) and local (no decode)
 *   transcription.
 * - `blob`: container bytes from anywhere else: navigator (Opus/WebM
 *   or mp4/AAC), VAD speech captures, file uploads, history replays.
 *   The transcribe layer either passes it through or compresses if the
 *   bytes look like an unencoded WAV.
 */
export type AudioArtifact =
	| {
			kind: 'pcm';
			samples: Float32Array;
			rate: number;
			channels: number;
	  }
	| {
			kind: 'blob';
			blob: Blob;
	  };

/**
 * Discriminated union for recording parameters based on method
 */
export type StartRecordingParams =
	| CpalRecordingParams
	| NavigatorRecordingParams;

/**
 * A live recording session bound to the backend that started it.
 *
 * The `Recording` is the unit of lifecycle: it knows its own backend, owns
 * its own teardown, and exposes per-session state changes. Toggling
 * `recording.method` after construction has no effect on an in-flight
 * Recording, which is what fixes the swap-mid-recording leak.
 *
 * The `subscribe` handler is invoked synchronously with the current state on
 * subscribe (so callers don't have to mirror "I just started" themselves),
 * then again whenever the session transitions, ending with 'IDLE' on
 * stop/cancel.
 */
export type Recording = {
	readonly recordingId: string;
	readonly backend: 'navigator' | 'cpal';
	stop(callbacks: {
		sendStatus: UpdateStatusMessageFn;
	}): Promise<
		Result<
			{ artifact: AudioArtifact; recordingId: string; durationMs: number },
			RecorderError
		>
	>;
	cancel(callbacks: {
		sendStatus: UpdateStatusMessageFn;
	}): Promise<Result<CancelRecordingResult, RecorderError>>;
	subscribe(handler: (state: WhisperingRecordingState) => void): () => void;
};

/**
 * Factory for `Recording` sessions. Services no longer carry mutable
 * start/stop state directly; instead `startRecording` returns a Recording
 * whose methods are bound to the backend that produced it.
 */
export type RecorderService = {
	/**
	 * Probe for a Recording that already exists at module-load time. CPAL
	 * sessions can outlive a JS reload because the Rust process keeps the
	 * stream; navigator sessions cannot survive a reload and will always
	 * return null after one.
	 *
	 * Returns the live Recording bound to this backend, or null if none.
	 */
	getActiveRecording(): Promise<Result<Recording | null, RecorderError>>;

	/**
	 * Enumerate available recording devices with their labels and identifiers
	 */
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;

	/**
	 * Start a new recording session, returning the Recording handle along
	 * with the device acquisition outcome. The caller holds the Recording
	 * and uses its `stop`/`cancel`/`subscribe` for the rest of the session.
	 */
	startRecording(
		params: StartRecordingParams,
		callbacks: {
			sendStatus: UpdateStatusMessageFn;
		},
	): Promise<
		Result<
			{
				recording: Recording;
				deviceAcquisition: DeviceAcquisitionOutcome;
			},
			RecorderError
		>
	>;
};
