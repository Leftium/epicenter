/**
 * Recording state types and their display icons. These are plain unions: the
 * states are never validated at runtime, only used as compile-time types.
 */
export type WhisperingRecordingState = 'IDLE' | 'RECORDING';

export const RECORDER_STATE_TO_ICON = {
	IDLE: '🎙️',
	RECORDING: '⏹️',
} as const satisfies Record<WhisperingRecordingState, string>;

export type VadState = 'IDLE' | 'LISTENING' | 'SPEECH_DETECTED';

export const VAD_STATE_TO_ICON = {
	IDLE: '🎤',
	LISTENING: '💬',
	SPEECH_DETECTED: '👂',
} as const satisfies Record<VadState, string>;
