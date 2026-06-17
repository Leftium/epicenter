/**
 * Recording mode constants, options, and the per-state recording action
 * lookups. This file is the single owner of recording-button iconography
 * (ADR-0013).
 */

import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
import EarIcon from '@lucide/svelte/icons/ear';
import FileUpIcon from '@lucide/svelte/icons/file-up';
import MicIcon from '@lucide/svelte/icons/mic';
import SquareIcon from '@lucide/svelte/icons/square';
import type { Component } from 'svelte';
import type { VadState, WhisperingRecordingState } from './recording-states';

export const RECORDING_MODES = ['manual', 'vad', 'upload'] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export const RECORDING_MODE_OPTIONS = [
	{ label: 'Manual', value: 'manual' },
	{ label: 'Voice Activated', value: 'vad' },
	{ label: 'Upload File', value: 'upload' },
] as const satisfies {
	label: string;
	value: RecordingMode;
}[];

/**
 * The Lucide icon for each recording mode, used wherever a mode picker needs a
 * icon: the homepage mode toggle and the settings dropdown. Keyed by mode so
 * adding a mode forces a matching icon at compile time. VAD uses the ear, the
 * same listening metaphor the action button settles on.
 */
export const RECORDING_MODE_ICONS = {
	manual: MicIcon,
	vad: EarIcon,
	upload: FileUpIcon,
} as const satisfies Record<RecordingMode, Component<{ class?: string }>>;

/**
 * The icon and label the recording button shows in each recorder state.
 * The home cards and the config header both index these by state; each site
 * keeps its own sizing, chrome, and tooltip (ADR-0013). Manual and VAD are
 * separate state machines with separate verbs ("recording" vs "listening") and
 * an `IDLE` that means different things, so each gets its own table rather than
 * a shared one. `satisfies Record<State, ...>` forces a row when a state is
 * added.
 *
 * VAD shows the ear while idle or listening and only swaps to the waveform on
 * an active speech burst; the ear reads as "listening for speech" far better
 * than the old radio.
 */
export const MANUAL_RECORDING_BUTTON = {
	IDLE: { Icon: MicIcon, label: 'Start recording' },
	RECORDING: { Icon: SquareIcon, label: 'Stop recording' },
} as const satisfies Record<
	WhisperingRecordingState,
	{ Icon: Component<{ class?: string }>; label: string }
>;

export const VAD_RECORDING_BUTTON = {
	IDLE: { Icon: EarIcon, label: 'Start listening' },
	LISTENING: { Icon: EarIcon, label: 'Stop listening' },
	SPEECH_DETECTED: { Icon: AudioLinesIcon, label: 'Stop listening' },
} as const satisfies Record<
	VadState,
	{ Icon: Component<{ class?: string }>; label: string }
>;
