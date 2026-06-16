/**
 * Recording trigger constants and per-trigger metadata.
 *
 * A recording trigger is how the microphone starts capturing: `manual` (you
 * press a button or shortcut) or `vad` (voice activity detection starts and
 * stops the capture for you). File import is not a trigger; it has no live
 * capture, device, or shortcut, so it lives on its own surface, not here.
 */

import MicIcon from '@lucide/svelte/icons/mic';
import RadioIcon from '@lucide/svelte/icons/radio';
import type { Component } from 'svelte';

export const RECORDING_TRIGGERS = ['manual', 'vad'] as const;
export type RecordingTrigger = (typeof RECORDING_TRIGGERS)[number];

/**
 * Everything that varies per trigger, defined once. `satisfies Record<...>`
 * forces every field present for every trigger at compile time, and `as const`
 * keeps each `toggleCommandId` a literal so consumers get a real command id,
 * not a widened `string`.
 *
 * - `label` / `emoji`: the compact label and glyph for the settings dropdown.
 * - `Icon`: the full-size lucide icon for prominent surfaces (the homepage
 *   trigger toggle and recording cards).
 * - `toggleCommandId`: the command whose shortcut starts/stops a recording for
 *   this trigger, shared by the activation UI (which renders the recorder) and
 *   the setup-readiness check (which asks whether it's bound).
 */
export const RECORDING_TRIGGER_META = {
	manual: {
		label: 'Manual',
		emoji: '🎙️',
		Icon: MicIcon,
		toggleCommandId: 'toggleManualRecording',
	},
	vad: {
		label: 'Voice Activated',
		emoji: '🎤',
		Icon: RadioIcon,
		toggleCommandId: 'toggleVadRecording',
	},
} as const satisfies Record<
	RecordingTrigger,
	{
		label: string;
		emoji: string;
		Icon: Component<{ class?: string }>;
		toggleCommandId: string;
	}
>;

/**
 * Render-ready trigger list (value, label, compact emoji) in display order,
 * derived from the metadata so each trigger is described in exactly one place.
 */
export const RECORDING_TRIGGER_OPTIONS = RECORDING_TRIGGERS.map((value) => ({
	value,
	label: RECORDING_TRIGGER_META[value].label,
	icon: RECORDING_TRIGGER_META[value].emoji,
}));
