import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type {
	CancelRecordingResult,
	WhisperingRecordingState,
} from '$lib/constants/audio';
import type {
	Device,
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
	UpdateStatusMessageFn,
} from '$lib/services/types';

export const RecorderError = defineErrors({
	Service: ({ message }: { message: string }) => ({ message }),
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
	outputFolder: string;
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
 * FFmpeg recording parameters
 */
export type FfmpegRecordingParams = BaseRecordingParams & {
	method: 'ffmpeg';
	globalOptions: string;
	inputOptions: string;
	outputOptions: string;
	outputFolder: string;
};

/**
 * Discriminated union for recording parameters based on method
 */
export type StartRecordingParams =
	| CpalRecordingParams
	| NavigatorRecordingParams
	| FfmpegRecordingParams;

/**
 * Recorder service interface shared by all methods
 */
export type RecorderService = {
	/**
	 * Get the current recorder state
	 * Returns 'IDLE' if no recording is active, 'RECORDING' if recording is in progress
	 */
	getRecorderState(): Promise<Result<WhisperingRecordingState, RecorderError>>;

	/**
	 * Enumerate available recording devices with their labels and identifiers
	 */
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;

	/**
	 * Start a new recording session
	 */
	startRecording(
		params: StartRecordingParams,
		callbacks: {
			sendStatus: UpdateStatusMessageFn;
		},
	): Promise<Result<DeviceAcquisitionOutcome, RecorderError>>;

	/**
	 * Stop the current recording and return the audio blob
	 */
	stopRecording(callbacks: {
		sendStatus: UpdateStatusMessageFn;
	}): Promise<Result<Blob, RecorderError>>;

	/**
	 * Cancel the current recording without saving
	 */
	cancelRecording(callbacks: {
		sendStatus: UpdateStatusMessageFn;
	}): Promise<Result<CancelRecordingResult, RecorderError>>;
};
