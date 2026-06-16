/**
 * Recording trigger constants and options.
 *
 * A recording trigger is how the microphone starts capturing: `manual` (you
 * press a button or shortcut) or `vad` (voice activity detection starts and
 * stops the capture for you). File import is not a trigger; it has no live
 * capture, device, or shortcut, so it lives on its own surface, not here.
 */

import MicIcon from '@lucide/svelte/icons/mic';
import RadioIcon from '@lucide/svelte/icons/radio';
import type { Component } from 'svelte';

export const RECORDING_TRIGGERS = [
	'manual',
	'vad',
	// 'live',
	// 'cpal'
] as const;
export type RecordingTrigger = (typeof RECORDING_TRIGGERS)[number];

export const RECORDING_TRIGGER_OPTIONS = [
	{ label: 'Manual', value: 'manual', icon: '🎙️', desktopOnly: false },
	{ label: 'Voice Activated', value: 'vad', icon: '🎤', desktopOnly: false },
	// { label: 'Live', value: 'live', icon: '🎬', desktopOnly: false },
	// { label: 'CPAL', value: 'cpal', icon: '🔊', desktopOnly: true },
] as const satisfies {
	label: string;
	value: RecordingTrigger;
	icon: string;
	desktopOnly: boolean;
}[];

/**
 * Lucide icon per recording trigger for prominent surfaces (the homepage
 * trigger toggle and recording cards). The emoji
 * `RECORDING_TRIGGER_OPTIONS.icon` is the compact glyph used in the settings
 * dropdown; this is the full-size lucide iconography used everywhere else.
 * Keyed by trigger so adding a trigger forces a matching icon at compile time.
 */
export const RECORDING_TRIGGER_ICONS = {
	manual: MicIcon,
	vad: RadioIcon,
} as const satisfies Record<RecordingTrigger, Component<{ class?: string }>>;

/**
 * The command whose shortcut starts/stops a recording for this trigger. The
 * single source for this mapping, shared by the activation UI (which renders
 * the recorder) and the setup-readiness check (which asks whether it's bound).
 */
export function toggleCommandIdForTrigger(
	trigger: RecordingTrigger,
): 'toggleManualRecording' | 'toggleVadRecording' {
	return trigger === 'vad' ? 'toggleVadRecording' : 'toggleManualRecording';
}
