/**
 * Recording mode constants and options
 */

import FileUpIcon from '@lucide/svelte/icons/file-up';
import MicIcon from '@lucide/svelte/icons/mic';
import RadioIcon from '@lucide/svelte/icons/radio';
import type { Component } from 'svelte';

export const RECORDING_MODES = [
	'manual',
	'vad',
	'upload',
	// 'live',
	// 'cpal'
] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export const RECORDING_MODE_OPTIONS = [
	{ label: 'Manual', value: 'manual', desktopOnly: false },
	{ label: 'Voice Activated', value: 'vad', desktopOnly: false },
	{ label: 'Upload File', value: 'upload', desktopOnly: false },
	// { label: 'Live', value: 'live', desktopOnly: false },
	// { label: 'CPAL', value: 'cpal', desktopOnly: true },
] as const satisfies {
	label: string;
	value: RecordingMode;
	desktopOnly: boolean;
}[];

/**
 * The Lucide icon for each recording mode. This is the single owner of mode
 * iconography, used everywhere a mode needs a glyph: the homepage toggle, the
 * recording cards, and the settings dropdown. Keyed by mode so adding a mode
 * forces a matching icon at compile time.
 */
export const RECORDING_MODE_ICONS = {
	manual: MicIcon,
	vad: RadioIcon,
	upload: FileUpIcon,
} as const satisfies Record<RecordingMode, Component<{ class?: string }>>;
